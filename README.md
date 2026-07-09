# pi-tts

A [pi](https://github.com/badlogic/pi) extension that exposes the local `tts`
command (Kokoro/piper-backed neural TTS) as a typed `tts` tool the agent can
call directly.

## Install

This repo is a pi package. Install it with pi (no manual symlinks needed):

```bash
# HTTPS (works for public clones on machines with git credentials)
pi install git:github.com/ekenberg/pi-tts@main

# SSH (use this if HTTPS credential prompts fail)
pi install git:git@github.com:ekenberg/pi-tts@main
```

Then reload extensions in your running session:

```
/reload
```

To update later:

```bash
pi update --extensions        # reconcile the pinned ref
```

## Requirements

- The `tts` binary on PATH (Kokoro/piper-backed neural TTS). This extension
  only wraps that binary; it does not bundle a TTS engine.
- pi with extension support.

## Features

- Speak text aloud (or from a file) via the `tts` tool
- Voice selection by exact name, alias (`personal`, `calm`, `anchor`), or blend
- Speed and pause-scale control (defaults: speed 1.0, pause_scale 1.0)
- Save to a WAV file instead of playing
- `list_voices: true` fetches the live voice catalog on demand

## Usage (natural language)

- "read that summary aloud using sarah"
- "say hello there using af_sarah"
- "read this file out loud using extra long pauses between words"
- "save this to memo.wav"
- "what british female voices are available?" (triggers `list_voices`)

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

## Development

`pi install` clones this repo to pi's managed git location:

```
~/.pi/agent/git/github.com/ekenberg/pi-tts/
```

That clone is what pi actually loads, so the fastest edit loop is:

1. Edit `~/.pi/agent/git/github.com/ekenberg/pi-tts/tts.ts`.
2. `/reload` in pi and test (no reinstall needed — `/reload` re-reads the clone).
3. Repeat until happy.
4. In the clone dir: `git commit -am "..." && git push`.
5. In your own working copy (e.g. this syncthing dir): `git pull` to mirror.

Both directories track `origin/main`, so either can be the commit/push point.
Keep edits in one place at a time to avoid divergence.
