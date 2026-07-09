import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

/**
 * Exposes the local `tts` command (Kokoro/piper-backed neural TTS) as a typed
 * tool the agent can call directly. Text is streamed over stdin to avoid
 * ARG_MAX limits and quoting issues; flags map 1:1 to the `tts` CLI.
 */
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
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // Discovery mode: list voices instead of speaking.
      if (params.list_voices) {
        return await new Promise((resolve) => {
          const child = spawn("tts", ["--voices"], { signal });
          let out = "";
          let err = "";
          child.stdout?.on("data", (d) => (out += d));
          child.stderr?.on("data", (d) => (err += d));
          child.on("error", (e) =>
            resolve({
              content: [{ type: "text", text: `Error listing voices: ${e.message}` }],
              isError: true,
              details: {},
            }),
          );
          child.on("close", (code) => {
            if (code !== 0) {
              resolve({
                content: [
                  { type: "text", text: `tts --voices failed (${code}): ${err || out || "no output"}` },
                ],
                isError: true,
                details: {},
              });
            } else {
              resolve({ content: [{ type: "text", text: out || "(no voices reported)" }], details: {} });
            }
          });
        });
      }

      if (!params.text && !params.input_file) {
        return {
          content: [
            { type: "text", text: "Error: provide either 'text' or 'input_file'." },
          ],
          isError: true,
          details: {},
        };
      }

      const args: string[] = [];
      if (params.voice) args.push("-v", params.voice);
      if (params.speed !== undefined) args.push("-s", String(params.speed));
      if (params.pause_scale !== undefined) args.push("-P", String(params.pause_scale));
      if (params.output_file) args.push("-o", params.output_file);

      const useFile = !!params.input_file;
      if (useFile) {
        args.push("-f", params.input_file);
      }

      return await new Promise((resolve) => {
        const child = spawn("tts", args, { signal });
        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (d) => (stdout += d));
        child.stderr?.on("data", (d) => (stderr += d));

        if (!useFile && params.text) {
          child.stdin?.write(params.text);
          child.stdin?.end();
        }

        child.on("error", (err) => {
          resolve({
            content: [
              {
                type: "text",
                text: `Error launching tts: ${err.message}. Is the 'tts' binary on PATH?`,
              },
            ],
            isError: true,
            details: {},
          });
        });

        child.on("close", (code) => {
          if (code !== 0) {
            resolve({
              content: [
                {
                  type: "text",
                  text: `tts exited with code ${code}. ${stderr || stdout || "No output."}`,
                },
              ],
              isError: true,
              details: {},
            });
            return;
          }

          const spoken = useFile
            ? `file '${params.input_file}'`
            : `${params.text!.length} chars`;
          const result = params.output_file
            ? `Saved audio to ${params.output_file} (source: ${spoken})`
            : `Spoke ${spoken}`;
          resolve({
            content: [
              {
                type: "text",
                text: `${result} — voice: ${params.voice ?? "personal"}, speed: ${
                  params.speed ?? 1.0
                }, pause_scale: ${params.pause_scale ?? 1.0}.`,
              },
            ],
            details: {},
          });
        });
      });
    },
  });
}
