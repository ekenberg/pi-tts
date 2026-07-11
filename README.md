# pi-tts

> **Transparency:** This extension was generated with AI assistance
> ("vibeslopped"). The repository owner did not personally write the code.
> See [`DEV.md`](DEV.md) for how it works and how to modify it.

A [pi](https://github.com/badlogic/pi) extension that exposes the local `tts`
command (Kokoro/piper-backed neural TTS) as a typed `tts` tool the agent can
call directly.

## Install

This repo is a pi package. Install it with pi (no manual symlinks needed):

```bash
# SSH (reliable on the owner's machine)
pi install git:git@github.com:ekenberg/pi-tts@live

# HTTPS (works for the public repo on machines with git credentials)
pi install git:github.com/ekenberg/pi-tts@live
```

Then reload extensions in your running session:

```
/reload
```

Update later:

```bash
pi update --extensions
```

## Requirements

- The `tts` binary on PATH (Kokoro/piper-backed neural TTS). This extension
  only wraps that binary; it does not bundle a TTS engine.
- pi with extension support.

## Features

- Speak text aloud (or from a file) via the `tts` tool
- **Background playback**: speaking never blocks the agent; the tool returns
  immediately (after a short grace window that catches instant failures like
  a bad voice name) while audio plays on
- **Barge-in**: a new `tts` call interrupts current speech; `queue: true`
  plays it after the current one instead; `stop: true` stops everything
- Playback is killed on session shutdown/reload and on process exit — no
  orphaned audio after pi quits
- Voice selection by exact name, alias (`personal`, `calm`, `anchor`), or blend
- Speed and pause-scale control (defaults: speed 1.0, pause_scale 1.0)
- Save to a WAV file instead of playing (synchronous — no playback involved)
- `list_voices: true` fetches the live voice catalog on demand

## Usage (natural language)

- "read that summary aloud using sarah"
- "say hello there using af_sarah"
- "read this file out loud using extra long pauses between words"
- "save this to memo.wav"
- "what british female voices are available?" (triggers `list_voices`)
- "stop reading" / "quiet" (triggers `stop`)
- "and read this one after that" (triggers `queue`)

## Parameters

| Param         | Description                                                        |
|---------------|--------------------------------------------------------------------|
| `text`        | Text to speak (or use `input_file`)                                |
| `input_file`  | Read text from a file (`tts -f`)                                   |
| `voice`       | Voice name/alias/blend; default `personal`                         |
| `speed`       | Speed multiplier, default 1.0                                      |
| `pause_scale` | Pause scaling, default 1.0                                          |
| `output_file` | Save WAV instead of playing (`tts -o`)                             |
| `list_voices` | If true, list available voices instead of speaking                 |
| `stop`        | Stop background speech + clear queue (alone, or with new text)     |
| `queue`       | Play after current speech instead of interrupting                  |

## Development

See [`DEV.md`](DEV.md) for the repo layout, branches, and the edit loop.
