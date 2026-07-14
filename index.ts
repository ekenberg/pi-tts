/**
 * pi-tts — exposes the local `tts` command as a typed pi tool.
 *
 * TRANSPARENCY: This extension was generated with AI assistance
 * ("vibeslopped"); the repository owner did not hand-write the code.
 *
 * Design notes:
 *  - The model only ever sees friendly parameter names (text, voice, speed,
 *    pause_scale, output_file, input_file, list_voices, stop, queue). Mapping
 *    natural language onto those values is the model's job, steered by the
 *    parameter descriptions below — not by any code here.
 *  - This file is a dumb translator: it maps parameters onto `tts` CLI flags
 *    and spawns the binary. The flag syntax lives ONLY here (never in the
 *    model's prompt), so the model cannot get the shell syntax wrong.
 *  - Text is streamed over stdin (not argv) to avoid ARG_MAX limits and quoting
 *    pitfalls.
 *  - Spoken playback runs in the BACKGROUND: the tool returns after a short
 *    grace window (to catch immediate failures) while audio keeps playing.
 *    One playback at a time; a new call barge-ins (kills the old one) unless
 *    queue: true, and stop: true stops everything. Synthesis to output_file
 *    and list_voices stay synchronous.
 *  - Cleanup: `tts` is a shell script that spawns audio players, so we kill
 *    the whole process group (detached:true + kill(-pid)). Playback is stopped
 *    on session_shutdown (quit/reload/switch) and, as a safety net, from a
 *    process exit hook guarded via globalThis so /reload doesn't stack them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: object;
};

type Job = { args: string[]; stdinText: string; spoken: string; label: string };

// Minimal shape of the bits of the UI context we need for the footer status.
type StatusUI = {
  setStatus: (key: string, text: string | undefined) => void;
  theme: { fg: (color: string, text: string) => string };
};

/**
 * Calibrated pace presets (listening-tested by the owner). Single source of
 * truth for what natural-language pace words mean; models pick a preset
 * instead of reasoning about numbers. Explicit speed/pause_scale override.
 */
const PACE: Record<string, { speed?: number; pause?: number }> = {
  fast: { speed: 1.3 },
  slow: { speed: 0.8, pause: 1.5 },
  very_slow: { speed: 0.7, pause: 2.0 },
  long_pauses: { speed: 0.8, pause: 3.0 },
};

/**
 * Voice catalog: consumes `tts --voices --json` (machine-readable). The model
 * never sees this — it's wrapper-internal, used to resolve bare names, look up
 * per-language defaults, and gate backend-specific capabilities (kokoro accepts
 * -s/-p; chatterbox does not). Loaded lazily, cached for the process; on any
 * failure (spawn, parse, unknown schema) resolves to null and callers fall
 * back to the old pass-through behavior.
 */

type LanguageEntry = {
  backend: string;
  speed_supported: boolean;
  pause_scale_supported: boolean;
  default_voice?: string;
  voices: { female: string[]; male: string[] };
};

type VoiceInfo = {
  id: string;
  language: string;
  gender: "female" | "male";
  backend: string;
  speedSupported: boolean;
  pauseScaleSupported: boolean;
};

type VoiceCatalog = {
  schema: number;
  default_voice: string;
  aliases: Record<string, string>;
  languages: Record<string, LanguageEntry>;
  // derived indexes:
  byId: Map<string, VoiceInfo>;
  byBare: Map<string, string[]>; // bare name -> [full ids]
  langKeys: string[];
};

let catalogPromise: Promise<VoiceCatalog | null> | null = null;

function loadVoiceCatalog(): Promise<VoiceCatalog | null> {
  if (catalogPromise) return catalogPromise;
  catalogPromise = new Promise((resolve) => {
    const child = spawn("tts", ["--voices", "--json"]);
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stdin?.on("error", () => {});
    child.stdin?.end();
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        const raw = JSON.parse(out);
        if (raw.schema !== 1) {
          // Unknown schema version — refuse to guess.
          resolve(null);
          return;
        }
        const byId = new Map<string, VoiceInfo>();
        const byBareSet = new Map<string, Set<string>>();
        for (const [lang, entry] of Object.entries(raw.languages as Record<string, LanguageEntry>)) {
          for (const gender of ["female", "male"] as const) {
            for (const id of entry.voices?.[gender] ?? []) {
              byId.set(id, {
                id,
                language: lang,
                gender,
                backend: entry.backend,
                speedSupported: entry.speed_supported,
                pauseScaleSupported: entry.pause_scale_supported,
              });
              const bare = id.replace(/^[a-z]{2}_/, "");
              (byBareSet.get(bare) ?? byBareSet.set(bare, new Set()).get(bare)!).add(id);
            }
          }
        }
        const byBare = new Map<string, string[]>();
        for (const [b, ids] of byBareSet) byBare.set(b, [...ids]);
        resolve({
          schema: raw.schema,
          default_voice: raw.default_voice,
          aliases: raw.aliases ?? {},
          languages: raw.languages,
          byId,
          byBare,
          langKeys: Object.keys(raw.languages),
        });
      } catch {
        resolve(null); // unparseable — callers degrade gracefully
      }
    });
  });
  return catalogPromise;
}

/** A token is a "bare" name only if it has no id underscore, blend comma/colon. */
function looksBare(v: string): boolean {
  return !v.includes("_") && !v.includes(",") && !v.includes(":");
}

/**
 * Resolve a possibly-bare voice to a full id using the parsed JSON catalog.
 * Unknown/alias/blend -> passed through unchanged (tts resolves aliases
 * itself). Ambiguous across languages (e.g. 'dora' -> ef_dora/pf_dora) ->
 * error listing the candidates.
 */
async function resolveBare(
  v: string,
  cat: VoiceCatalog,
): Promise<{ id?: string; error?: string }> {
  if (!looksBare(v)) return { id: v }; // full id / alias / blend — pass through
  const hits = cat.byBare.get(v.trim().toLowerCase());
  if (!hits || hits.length === 0) return { id: v }; // unknown — let tts resolve/error
  if (hits.length === 1) return { id: hits[0] };
  return { error: `Voice '${v}' is ambiguous: ${hits.join(", ")}. Pass the full name.` };
}

// A few convenience aliases; canonical keys are the full language names.
const LANG_ALIASES: Record<string, string> = {
  en: "American English",
  english: "American English",
  sv: "Swedish",
  se: "Swedish",
};

function matchLanguage(cat: VoiceCatalog, lang: string): LanguageEntry | undefined {
  const key = lang.trim().toLowerCase();
  for (const k of cat.langKeys) if (k.toLowerCase() === key) return cat.languages[k];
  const aliased = LANG_ALIASES[key];
  if (aliased && cat.languages[aliased]) return cat.languages[aliased];
  for (const k of cat.langKeys) if (k.toLowerCase().startsWith(key)) return cat.languages[k];
  return undefined;
}

function firstVoice(entry: LanguageEntry): string | undefined {
  return entry.voices.female[0] ?? entry.voices.male[0];
}

// Resolve a voice string (id, alias, or blend) to its capability info.
function voiceInfoFor(cat: VoiceCatalog, voice: string): VoiceInfo | undefined {
  if (cat.byId.has(voice)) return cat.byId.get(voice);
  const expansion = cat.aliases[voice] ?? voice; // alias -> expansion, else itself
  const firstId = expansion.split(",")[0].split(":")[0].trim();
  return cat.byId.get(firstId);
}

export default function (pi: ExtensionAPI) {
  // --- Background playback state: one active playback + FIFO queue ---
  let current: { child: ChildProcess; pid: number; paused: boolean; label: string } | null = null;
  const queue: Job[] = [];

  // Signal a whole process group; ignore errors (group already gone).
  const signalGroup = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      /* already gone */
    }
  };
  // Kill a group cleanly. SIGCONT first so a PAUSED (SIGSTOP'd) group actually
  // receives the SIGTERM — otherwise TERM is queued until resume => stopped orphan.
  const killGroup = (pid: number) => {
    signalGroup(pid, "SIGCONT");
    signalGroup(pid, "SIGTERM");
  };

  // Footer status. Cached UI ref (captured from session_start / tool execute)
  // so we can update the footer even from a child 'close' event or a slash
  // command — neither of which carries a setStatus-capable context.
  let statusUi: StatusUI | undefined;
  function renderStatus(): void {
    if (!statusUi) return;
    if (!current) {
      statusUi.setStatus("tts", undefined);
      return;
    }
    const q = queue.length ? ` +${queue.length}` : "";
    // Leading dim "| " separator: pi only space-joins extension statuses, so we
    // add our own divider from the preceding one (TTS sorts last on the line).
    const sep = statusUi.theme.fg("dim", "| ");
    statusUi.setStatus(
      "tts",
      current.paused
        ? sep + statusUi.theme.fg("warning", `TTS: ⏸${q}`)
        : sep + statusUi.theme.fg("accent", `TTS: ▶${q}`),
    );
  }

  // Safety net for exits where session_shutdown never fires. Registered once
  // per process (globalThis guard prevents /reload from stacking handlers);
  // reads the live process-group id from globalThis.
  const g = globalThis as { __piTtsPgid?: number; __piTtsExitHook?: boolean };
  const setPgid = (pid: number | undefined) => (g.__piTtsPgid = pid);
  if (!g.__piTtsExitHook) {
    g.__piTtsExitHook = true;
    process.on("exit", () => {
      // CONT then TERM: don't strand a paused group on quit/reload.
      if (g.__piTtsPgid) {
        try {
          process.kill(-g.__piTtsPgid, "SIGCONT");
          process.kill(-g.__piTtsPgid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    });
  }

  /** Kill current playback (whole process group) and drop the queue. */
  function stopAll(): { stopped: boolean; dropped: number } {
    const dropped = queue.length;
    queue.length = 0;
    if (!current) return { stopped: false, dropped };
    if (current.pid) killGroup(current.pid);
    current = null;
    setPgid(undefined);
    renderStatus();
    return { stopped: true, dropped };
  }

  /** Pause current playback (freezes the whole pipeline; the queue waits). */
  function pausePlayback(): string {
    if (!current) return "Nothing is playing.";
    if (current.paused) return "Already paused.";
    signalGroup(current.pid, "SIGSTOP");
    current.paused = true;
    renderStatus();
    return `Paused (${current.label}).`;
  }

  /** Resume paused playback. */
  function resumePlayback(): string {
    if (!current) return "Nothing is playing.";
    if (!current.paused) return "Not paused.";
    signalGroup(current.pid, "SIGCONT");
    current.paused = false;
    renderStatus();
    return `Resumed (${current.label}).`;
  }

  /**
   * Skip only the current utterance, keeping the queue. We advance the queue
   * SYNCHRONOUSLY here (rather than leaning on the async close handler) so the
   * returned message and any immediately-following /tts-status report the same,
   * already-updated counts. The dead child's close will no-op because `current`
   * no longer references it.
   */
  function skipPlayback(): string {
    if (!current) return "Nothing is playing to skip.";
    killGroup(current.pid);
    current = null;
    setPgid(undefined);
    const next = queue.shift();
    if (next) startJob(next);
    else renderStatus();
    return next
      ? `Skipped. Now playing the next item; ${queue.length} still queued.`
      : "Skipped. Queue is now empty.";
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.ui) statusUi = ctx.ui as StatusUI;
    renderStatus();
  });

  pi.on("session_shutdown", async () => {
    stopAll();
  });

  /** Spawn a background playback job and wire up queue advancement. */
  function startJob(job: Job): ChildProcess {
    // detached: own process group, so kill(-pid) reaches the audio players
    // the tts script spawns. unref: never keep pi's event loop alive.
    const child = spawn("tts", job.args, {
      detached: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.unref();
    child.stdin?.unref?.();
    child.stderr?.unref?.();
    // Swallow stdin stream errors (e.g. EPIPE when the binary is missing or
    // exits early) — otherwise an unhandled 'error' event crashes the host.
    child.stdin?.on("error", () => {});
    if (job.stdinText) child.stdin?.write(job.stdinText);
    child.stdin?.end();

    current = { child, pid: child.pid ?? 0, paused: false, label: job.label };
    setPgid(child.pid);
    renderStatus();

    const advance = () => {
      if (current?.child !== child) return; // superseded by barge-in/stop
      current = null;
      setPgid(undefined);
      const next = queue.shift();
      if (next) startJob(next);
      else renderStatus();
    };
    child.on("close", advance);
    child.on("error", advance);
    return child;
  }

  /**
   * Start a job and wait a short grace window so immediate failures (missing
   * binary, bad voice name) still surface synchronously to the model.
   */
  function startWithGrace(job: Job, graceMs = 500): Promise<{ error?: string }> {
    return new Promise((resolve) => {
      const child = startJob(job);
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += d));
      let settled = false;
      const settle = (r: { error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => settle({}), graceMs);
      child.on("error", (e) => settle({ error: e.message }));
      child.on("close", (code) =>
        settle(code === 0 || code === null ? {} : { error: stderr.trim() || `exit ${code}` }),
      );
    });
  }

  // --- Slash commands: user-typed transport controls, zero LLM round-trip ---
  const transport: Array<[string, () => string]> = [
    ["tts-pause", pausePlayback],
    ["tts-resume", resumePlayback],
    ["tts-skip", skipPlayback],
    [
      "tts-stop",
      () => {
        const { stopped, dropped } = stopAll();
        return stopped
          ? `Stopped playback${dropped ? ` (dropped ${dropped} queued)` : ""}.`
          : "Nothing was playing.";
      },
    ],
  ];
  for (const [name, fn] of transport) {
    pi.registerCommand(name, {
      description: `TTS: ${name.slice(4)} playback`,
      handler: async (_args, ctx) => {
        ctx.ui.notify(fn(), "info");
      },
    });
  }
  pi.registerCommand("tts-status", {
    description: "TTS: show playback status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        current
          ? `${current.paused ? "Paused" : "Speaking"}: ${current.label}; ${queue.length} queued.`
          : "TTS idle.",
        "info",
      );
    },
  });

  pi.registerTool({
    name: "tts",
    label: "Text to Speech",
    description:
      "Speak text aloud using the local `tts` command — only when the user explicitly asks for audio. " +
      "Playback runs in the background and does not block; a new call interrupts current speech (or plays after it with queue: true), and stop: true stops it. " +
      "Supports voice selection, speed, pause scaling, and saving to a WAV file instead of playing. " +
      "VOICE: for non-English text, set `language` (e.g. 'Swedish', 'French') and the tool picks an appropriate voice — do NOT set `voice` unless the user names a specific voice. " +
      "For English, omit both to use the default. " +
      "TEXT: before speaking, rewrite the text into natural speech — expand acronyms/numbers the TTS would mispronounce (e.g. 'MOE' -> 'mixture of experts', '1M' -> 'one million') and strip markdown like '* _ #' — unless the user says 'verbatim'.",
    promptSnippet: "Speak text aloud via the local tts command",
    promptGuidelines: [
      "Only call the tts tool when the user explicitly asks for audio ('read aloud', 'speak', 'say it', 'use tts') — or continues an active listening session ('stop', 'skip that', 'queue this next'). Plain 'tell me X' or 'what is X' means a normal text answer, NOT speech.",
    ],
    parameters: Type.Object({
      text: Type.Optional(
        Type.String({ description: "Text to speak. Required unless input_file is supplied." }),
      ),
      input_file: Type.Optional(
        Type.String({
          description:
            "Read text from this file instead of the text parameter. Takes precedence over text if both are given.",
        }),
      ),
      voice: Type.Optional(
        Type.String({
          description:
            "Specific voice name or alias. Only set this when the user names a particular voice " +
            "(e.g. 'onyx', 'allan', 'af_sarah', or a blend 'af_sarah:60,am_adam:40'); the tool resolves " +
            "bare names and aliases automatically. Otherwise leave empty and set `language` for " +
            "non-English text, or leave both empty for the English default.",
        }),
      ),
      language: Type.Optional(
        Type.String({
          description:
            "Speak with a voice of this language (e.g. 'Swedish', 'French', 'American English'). " +
            "Set this for non-English text; the tool selects an appropriate voice for that language. " +
            "Leave empty for the English default. Do not set `voice` at the same time unless the user named a specific voice.",
        }),
      ),
      list_voices: Type.Optional(
        Type.Boolean({
          description:
            "If true, list all available voices (and aliases) instead of speaking. Use this to discover the exact voice name when you only know a language/gender or a descriptive style.",
        }),
      ),
      pace: Type.Optional(
        Type.Union(
          [
            Type.Literal("fast"),
            Type.Literal("slow"),
            Type.Literal("very_slow"),
            Type.Literal("long_pauses"),
          ],
          {
            description:
              "Preset reading pace — preferred over raw numbers. Map natural language: 'fast/quickly' → fast; 'slowly/clearly' → slow; 'very slowly/meditative' → very_slow; 'with (very) long pauses' → long_pauses. Omit for normal pace.",
          },
        ),
      ),
      speed: Type.Optional(
        Type.Number({
          minimum: 0.7,
          maximum: 1.5,
          description:
            "Fine-grained speed multiplier (0.7–1.5, 1.0 = normal). Only for explicit numeric requests; otherwise use pace. Overrides the pace preset's speed.",
        }),
      ),
      pause_scale: Type.Optional(
        Type.Number({
          minimum: 1.0,
          maximum: 4.0,
          description:
            "Fine-grained pause length between sentences (1.0–4.0, 1.0 = normal). Only for explicit numeric requests; otherwise use pace. Overrides the pace preset's pauses.",
        }),
      ),
      output_file: Type.Optional(
        Type.String({
          description: "Save audio to this WAV file instead of speaking aloud.",
        }),
      ),
      stop: Type.Optional(
        Type.Boolean({
          description:
            "Stop speech entirely: kills current playback AND clears the queue. Use alone to just stop, or with text to stop-then-speak.",
        }),
      ),
      skip: Type.Optional(
        Type.Boolean({
          description:
            "Skip the current utterance; queued ones continue. Use alone, or with text to speak it now without dropping the queue. Overrides stop.",
        }),
      ),
      queue: Type.Optional(
        Type.Boolean({
          description:
            "If something is already speaking, play this after it finishes instead of interrupting it.",
        }),
      ),
      pause: Type.Optional(
        Type.Boolean({
          description:
            "Pause current playback (resume with resume: true or /tts-resume). Use alone.",
        }),
      ),
      resume: Type.Optional(
        Type.Boolean({ description: "Resume paused playback. Use alone." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult> {
      // Capture a setStatus-capable UI ref for the footer (see renderStatus).
      if (ctx?.ui) statusUi = ctx.ui as StatusUI;

      // Discovery mode: dump the live voice catalog instead of speaking.
      if (params.list_voices) {
        const r = await runTts(["--voices"], "", signal, "Error listing voices");
        if (!r.isError && r.content[0]) {
          r.content[0].text +=
            "\n\nTip: select any voice by its bare name (e.g. 'onyx', 'isabella', 'emma') — " +
            "the lang/gender prefix is optional and resolved automatically.";
        }
        return r;
      }

      // Forgiving action precedence for small models: every flag combo does
      // something sensible, nothing is silently ignored. skip beats stop:
      // a model that sends both almost always came from skip-flavored
      // phrasing ("stop this one, skip to the next"); a full stop is
      // expressed as stop alone.
      const wantSkip = !!params.skip;
      const wantStop = !!params.stop && !wantSkip;
      const hasSource = !!params.text || !!params.input_file;
      let note = "";

      if (wantStop) {
        const { stopped, dropped } = stopAll();
        note = stopped
          ? `Stopped playback${dropped ? ` (dropped ${dropped} queued)` : ""}. `
          : "Nothing was playing. ";
        if (!hasSource) {
          return { content: [{ type: "text", text: note.trim() }], details: {} };
        }
      }

      // Skip: kill only the current utterance, keep the queue. Without text
      // the queue advances by itself (the dying child's close handler shifts
      // it); with text the new utterance replaces `current` first, so the
      // queue survives and plays after it.
      if (wantSkip) {
        // Pure skip (no new text): advance synchronously with accurate counts.
        if (!hasSource) {
          return { content: [{ type: "text", text: skipPlayback() }], details: {} };
        }
        // Skip + new text: kill current, KEEP the queue; the new utterance below
        // becomes `current`, pre-empting the dead child's auto-advance.
        if (current) {
          killGroup(current.pid);
          note = "Skipped current playback. ";
        } else {
          note = "Nothing was playing to skip. ";
        }
      }

      // Control-only actions (no text): pause/resume act here. When text IS
      // present they are ignored and the speak path runs (barge-in cleans any
      // paused job), because "pause/resume then say X" is incoherent.
      if (!hasSource) {
        if (params.pause) {
          return { content: [{ type: "text", text: pausePlayback() }], details: {} };
        }
        if (params.resume) {
          return { content: [{ type: "text", text: resumePlayback() }], details: {} };
        }
        return {
          content: [{ type: "text", text: "Error: provide either 'text' or 'input_file'." }],
          isError: true,
          details: {},
        };
      }

      // Resolve pace preset; explicit numeric params override it.
      const preset = params.pace ? PACE[params.pace] : undefined;
      let speed = params.speed ?? preset?.speed;
      let pause = params.pause_scale ?? preset?.pause;
      const reqSpeed = speed; // remember what was requested, before capability gating
      const reqPause = pause;

      // --- Voice selection: explicit voice > language > English default ---
      const cat = await loadVoiceCatalog();
      let voice: string | undefined = params.voice;
      let pickedVia = "default";

      if (voice) {
        // Explicit override (user named a voice). Resolve bare names via the catalog.
        if (cat) {
          const r = await resolveBare(voice, cat);
          if (r.error) {
            return { content: [{ type: "text", text: r.error }], isError: true, details: {} };
          }
          voice = r.id;
        }
        pickedVia = "voice";
      } else if (params.language) {
        if (!cat) {
          return {
            content: [{ type: "text", text: "Voice catalog unavailable; cannot resolve language. Set `voice` explicitly or retry." }],
            isError: true,
            details: {},
          };
        }
        const entry = matchLanguage(cat, params.language);
        if (!entry) {
          return {
            content: [{ type: "text", text: `Unknown language '${params.language}'. Available: ${cat.langKeys.join(", ")}` }],
            isError: true,
            details: {},
          };
        }
        voice = entry.default_voice ?? firstVoice(entry);
        pickedVia = `language:${params.language}`;
      } else {
        // English default. Use the catalog default (alias "personal"); omit -v if unavailable.
        voice = cat?.default_voice;
        pickedVia = "default";
      }

      // --- Capability gating: drop -s/-p the selected voice's backend rejects ---
      if (voice && cat) {
        const info = voiceInfoFor(cat, voice);
        if (info) {
          if (!info.speedSupported) speed = undefined;
          if (!info.pauseScaleSupported) pause = undefined;
        }
      }
      // A requested pace was dropped because the backend rejects it (e.g.
      // chatterbox/Swedish). Surface it so the result line doesn't misreport.
      const paceDropped =
        (reqSpeed !== undefined && speed === undefined) ||
        (reqPause !== undefined && pause === undefined);

      // Map friendly parameters -> tts CLI flags. This is the ONLY place the
      // flag syntax exists; the model never sees it.
      const args: string[] = [];
      if (voice) args.push("-v", voice);
      if (speed !== undefined) args.push("-s", String(speed));
      if (pause !== undefined) args.push("-p", String(pause));
      if (params.output_file) args.push("-o", params.output_file);

      const useFile = !!params.input_file;
      if (useFile) args.push("-f", params.input_file!);

      // Feed text over stdin to avoid ARG_MAX / quoting issues.
      const stdinText = useFile ? "" : params.text ?? "";

      const spoken = useFile ? `file '${params.input_file}'` : `${params.text!.length} chars`;
      const voiceLabel =
        voice == null
          ? "binary default"
          : pickedVia === "voice" && voice !== params.voice
            ? `${params.voice}→${voice}`
            : pickedVia.startsWith("language:")
              ? `${pickedVia}→${voice}`
              : voice;
      const settings = `voice: ${voiceLabel}${
        params.pace ? `, pace: ${params.pace}` : ""
      }, speed: ${speed ?? 1.0}, pause_scale: ${pause ?? 1.0}${
        paceDropped ? " (pace not supported by this voice)" : ""
      }`;

      // File synthesis: no playback involved, stay synchronous.
      if (params.output_file) {
        const result = await runTts(args, stdinText, signal, "Error launching tts");
        if (result.isError) return result;
        return {
          content: [
            {
              type: "text",
              text: `${note}Saved audio to ${params.output_file} (source: ${spoken}) — ${settings}.`,
            },
          ],
          details: {},
        };
      }

      const job: Job = { args, stdinText, spoken, label: `${spoken}, ${voiceLabel}` };

      // queue: true → play after whatever is speaking (and any queued items).
      if (params.queue && current) {
        queue.push(job);
        renderStatus();
        return {
          content: [
            {
              type: "text",
              text: `${note}Queued ${spoken} (position ${queue.length}) — ${settings}.`,
            },
          ],
          details: {},
        };
      }

      // Default: barge-in — new speech replaces current playback + queue.
      // After skip we keep the queue: startJob replaces `current` before the
      // dying child's close handler runs, so the queue is not advanced twice.
      if (!wantSkip) {
        const interrupted = stopAll().stopped;
        if (!note && interrupted) note = "Interrupted previous playback. ";
      }
      const { error } = await startWithGrace(job);
      if (error) {
        return {
          content: [{ type: "text", text: `Error launching tts: ${error}` }],
          isError: true,
          details: {},
        };
      }
      const after = wantSkip && queue.length ? ` ${queue.length} queued item(s) follow.` : "";
      return {
        content: [
          {
            type: "text",
            text: `${note}Speaking ${spoken} in background — ${settings}. Interrupt with stop: true.${after}`,
          },
        ],
        details: {},
      };
    },
  });
}

/**
 * Spawn `tts` synchronously (used for list_voices and output_file synthesis):
 * wait for exit, capture output. On non-zero exit or spawn error, returns an
 * error result carrying the captured stderr/stdout.
 */
function runTts(
  args: string[],
  stdinText: string,
  signal: AbortSignal | undefined,
  errorPrefix: string,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn("tts", args, { signal });
    let out = "";
    let err = "";

    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    // Swallow stdin stream errors (e.g. EPIPE when the binary is missing or
    // exits early) — otherwise an unhandled 'error' event crashes the host.
    child.stdin?.on("error", () => {});
    // Always close stdin so `tts` sees EOF and exits even when text is empty.
    if (stdinText) child.stdin?.write(stdinText);
    child.stdin?.end();

    child.on("error", (e) => {
      // Abort via signal surfaces here as AbortError (before 'close' fires);
      // report it as a clean cancellation, not a failure.
      if (e.name === "AbortError") {
        resolve({ content: [{ type: "text", text: "tts: aborted by user." }], details: {} });
        return;
      }
      resolve({
        content: [{ type: "text", text: `${errorPrefix}: ${e.message}` }],
        isError: true,
        details: {},
      });
    });
    child.on("close", (code) => {
      // code === null: killed by a signal without a JS-side abort (external
      // kill, OOM, ...). The AbortError path above handles user cancels.
      if (code === null) {
        resolve({
          content: [{ type: "text", text: `${errorPrefix}: terminated by signal.` }],
          isError: true,
          details: {},
        });
        return;
      }
      if (code !== 0) {
        resolve({
          content: [{ type: "text", text: `${errorPrefix} (exit ${code}): ${err || out || "no output"}` }],
          isError: true,
          details: {},
        });
      } else {
        resolve({ content: [{ type: "text", text: out || "(no output)" }], details: {} });
      }
    });
  });
}
