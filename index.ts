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

type Job = { args: string[]; stdinText: string; spoken: string };

export default function (pi: ExtensionAPI) {
  // --- Background playback state: one active playback + FIFO queue ---
  let current: { child: ChildProcess; pid: number } | null = null;
  const queue: Job[] = [];

  // Safety net for exits where session_shutdown never fires. Registered once
  // per process (globalThis guard prevents /reload from stacking handlers);
  // reads the live process-group id from globalThis.
  const g = globalThis as { __piTtsPgid?: number; __piTtsExitHook?: boolean };
  const setPgid = (pid: number | undefined) => (g.__piTtsPgid = pid);
  if (!g.__piTtsExitHook) {
    g.__piTtsExitHook = true;
    process.on("exit", () => {
      if (g.__piTtsPgid) {
        try {
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
    if (current.pid) {
      try {
        process.kill(-current.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    current = null;
    setPgid(undefined);
    return { stopped: true, dropped };
  }

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

    current = { child, pid: child.pid ?? 0 };
    setPgid(child.pid);

    const advance = () => {
      if (current?.child !== child) return; // superseded by barge-in/stop
      current = null;
      setPgid(undefined);
      const next = queue.shift();
      if (next) startJob(next);
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

  pi.registerTool({
    name: "tts",
    label: "Text to Speech",
    description:
      "Speak text aloud using the local `tts` command (Kokoro/piper-backed neural TTS). Playback runs in the background and does not block; a new call interrupts current speech (or plays after it with queue: true), and stop: true stops it. Supports voice selection, speed, pause scaling, and saving to a WAV file instead of playing.",
    promptSnippet: "Speak text aloud via the local tts command",
    promptGuidelines: [
      "Use tts to read text aloud when the user asks to hear something or wants audio output; pass output_file to save a WAV instead of speaking.",
      "Playback is background and non-blocking; a new call interrupts current speech. Use stop: true to stop it, queue: true to play after the current one.",
      "Omit voice for the user's default. If you don't know a voice's exact name, call with list_voices: true first, then call again with the chosen voice.",
    ],
    parameters: Type.Object({
      text: Type.Optional(
        Type.String({ description: "Text to speak. Required unless input_file is supplied." }),
      ),
      input_file: Type.Optional(
        Type.String({
          description:
            "Read text from this file instead of the text parameter (maps to tts -f). Takes precedence over text if both are given.",
        }),
      ),
      voice: Type.Optional(
        Type.String({
          description:
            "Voice name/alias or blend, e.g. 'am_adam', 'af_sarah', or 'af_sarah:60,am_adam:40'. Defaults to the personal voice. " +
            "Naming scheme: [lang][gender]_name where lang = a=American, b=British, e=Spanish, f=French, h=Hindi, i=Italian, j=Japanese, p=Portuguese, z=Chinese; " +
            "gender = f=female, m=male (e.g. 'bf_emma' = British female). Stable aliases: 'personal' (default), 'calm', 'anchor'. " +
            "Don't know the exact name? Use list_voices: true to fetch the live catalog.",
        }),
      ),
      list_voices: Type.Optional(
        Type.Boolean({
          description:
            "If true, list all available voices (and aliases) instead of speaking. Use this to discover the exact voice name when you only know a language/gender or a descriptive style.",
        }),
      ),
      speed: Type.Optional(
        Type.Number({
          description: "Speech speed multiplier. 1.0 = normal, >1 faster. Default 1.0.",
        }),
      ),
      pause_scale: Type.Optional(
        Type.Number({
          description:
            "Natural pause scaling between sentences. Default 1.0 (full natural pauses); >1.0 = slower cadence, <1.0 = clipped/snappy.",
        }),
      ),
      output_file: Type.Optional(
        Type.String({
          description: "Save audio to this WAV file instead of speaking aloud (maps to tts -o).",
        }),
      ),
      stop: Type.Optional(
        Type.Boolean({
          description:
            "Stop current background speech and clear the queue. Use alone to just stop, or together with text to stop-then-speak.",
        }),
      ),
      queue: Type.Optional(
        Type.Boolean({
          description:
            "If something is already speaking, play this after it finishes instead of interrupting it.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx): Promise<ToolResult> {
      // Discovery mode: dump the live voice catalog instead of speaking.
      if (params.list_voices) {
        return runTts(["--voices"], "", signal, "Error listing voices");
      }

      // Stop mode: kill playback + queue; may be combined with new text.
      let stopNote = "";
      if (params.stop) {
        const { stopped, dropped } = stopAll();
        stopNote = stopped
          ? `Stopped playback${dropped ? ` (dropped ${dropped} queued)` : ""}. `
          : "Nothing was playing. ";
        if (!params.text && !params.input_file) {
          return { content: [{ type: "text", text: stopNote.trim() }], details: {} };
        }
      }

      if (!params.text && !params.input_file) {
        return {
          content: [{ type: "text", text: "Error: provide either 'text' or 'input_file'." }],
          isError: true,
          details: {},
        };
      }

      // Map friendly parameters -> tts CLI flags. This is the ONLY place the
      // flag syntax exists; the model never sees it.
      const args: string[] = [];
      if (params.voice) args.push("-v", params.voice);
      if (params.speed !== undefined) args.push("-s", String(params.speed));
      if (params.pause_scale !== undefined) args.push("-p", String(params.pause_scale));
      if (params.output_file) args.push("-o", params.output_file);

      const useFile = !!params.input_file;
      if (useFile) args.push("-f", params.input_file!);

      // Feed text over stdin to avoid ARG_MAX / quoting issues.
      const stdinText = useFile ? "" : params.text ?? "";

      const spoken = useFile ? `file '${params.input_file}'` : `${params.text!.length} chars`;
      const settings = `voice: ${params.voice ?? "personal"}, speed: ${
        params.speed ?? 1.0
      }, pause_scale: ${params.pause_scale ?? 1.0}`;

      // File synthesis: no playback involved, stay synchronous.
      if (params.output_file) {
        const result = await runTts(args, stdinText, signal, "Error launching tts");
        if (result.isError) return result;
        return {
          content: [
            {
              type: "text",
              text: `${stopNote}Saved audio to ${params.output_file} (source: ${spoken}) — ${settings}.`,
            },
          ],
          details: {},
        };
      }

      const job: Job = { args, stdinText, spoken };

      // queue: true → play after whatever is currently speaking.
      if (params.queue && current) {
        queue.push(job);
        return {
          content: [
            { type: "text", text: `Queued ${spoken} (position ${queue.length}) — ${settings}.` },
          ],
          details: {},
        };
      }

      // Default: barge-in. New speech replaces current playback + queue.
      const interrupted = stopAll().stopped;
      const { error } = await startWithGrace(job);
      if (error) {
        return {
          content: [{ type: "text", text: `Error launching tts: ${error}` }],
          isError: true,
          details: {},
        };
      }
      const note = stopNote || (interrupted ? "Interrupted previous playback. " : "");
      return {
        content: [
          {
            type: "text",
            text: `${note}Speaking ${spoken} in background — ${settings}. Interrupt with stop: true.`,
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
