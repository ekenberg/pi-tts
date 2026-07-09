/**
 * pi-tts — exposes the local `tts` command as a typed pi tool.
 *
 * TRANSPARENCY: This extension was generated with AI assistance
 * ("vibeslopped"); the repository owner did not hand-write the code.
 *
 * Design notes:
 *  - The model only ever sees friendly parameter names (text, voice, speed,
 *    pause_scale, output_file, input_file, list_voices). Mapping natural
 *    language onto those values is the model's job, steered by the parameter
 *    descriptions below — not by any code here.
 *  - This file is a dumb translator: it maps parameters onto `tts` CLI flags
 *    and spawns the binary. The flag syntax lives ONLY here (never in the
 *    model's prompt), so the model cannot get the shell syntax wrong.
 *  - Text is streamed over stdin (not argv) to avoid ARG_MAX limits and quoting
 *    pitfalls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: object;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "tts",
    label: "Text to Speech",
    description:
      "Speak text aloud using the local `tts` command (Kokoro/piper-backed neural TTS). Use to read messages, summaries, or notifications out loud. Supports voice selection, speed, pause scaling, and saving to a WAV file instead of playing.",
    promptSnippet: "Speak text aloud via the local tts command",
    promptGuidelines: [
      "Use tts to read text aloud when the user asks to hear something, wants audio output, or wants a summary spoken.",
      "Use tts with output_file to generate a WAV file the user can play or download later instead of speaking immediately.",
      "Prefer concise text for tts; long documents are spoken in full and take longer to synthesize.",
      "Omit voice to use the user's default personal voice; pass voice (e.g. 'am_adam', 'af_sarah', or a blend like 'af_sarah:60,am_adam:40') to override.",
      "To choose a voice you don't know by exact name, call tts with list_voices: true to fetch the live catalog, then call again with the chosen voice.",
      "Construct a language/gender hint from the scheme (a=American, b=British, e=Spanish, f=French, h=Hindi, i=Italian, j=Japanese, p=Portuguese, z=Chinese; f=female, m=male), but use list_voices to get the specific name. Known aliases: personal, calm, anchor.",
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
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx): Promise<ToolResult> {
      // Discovery mode: dump the live voice catalog instead of speaking.
      if (params.list_voices) {
        return runTts(["--voices"], "", signal, "Error listing voices");
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
      if (params.pause_scale !== undefined) args.push("-P", String(params.pause_scale));
      if (params.output_file) args.push("-o", params.output_file);

      const useFile = !!params.input_file;
      if (useFile) args.push("-f", params.input_file);

      // Feed text over stdin to avoid ARG_MAX / quoting issues.
      const stdinText = useFile ? "" : params.text ?? "";

      const result = await runTts(args, stdinText, signal, "Error launching tts");
      if (result.isError) return result;

      const spoken = useFile ? `file '${params.input_file}'` : `${params.text!.length} chars`;
      const what = params.output_file
        ? `Saved audio to ${params.output_file} (source: ${spoken})`
        : `Spoke ${spoken}`;
      const summary = `${what} — voice: ${params.voice ?? "personal"}, speed: ${
        params.speed ?? 1.0
      }, pause_scale: ${params.pause_scale ?? 1.0}.`;

      return { content: [{ type: "text", text: summary }], details: {} };
    },
  });
}

/**
 * Spawn `tts` with the given args, optionally writing `stdinText` to stdin.
 * Resolves to a pi tool result. On non-zero exit or spawn error, returns an
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
    if (stdinText) {
      child.stdin?.write(stdinText);
      child.stdin?.end();
    }

    child.on("error", (e) =>
      resolve({
        content: [{ type: "text", text: `${errorPrefix}: ${e.message}` }],
        isError: true,
        details: {},
      }),
    );
    child.on("close", (code) => {
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
