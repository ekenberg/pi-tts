# pi-tts

A [pi](https://github.com/badlogic/pi) extension that exposes the local `tts`
command (Kokoro/piper-backed neural TTS) as a typed `tts` tool the agent can
call directly.

## Features

- Speak text aloud (or from a file) via the `tts` tool
- Voice selection by exact name, alias (`personal`, `calm`, `anchor`), or blend
- Speed and pause-scale control
- Save to a WAV file instead of playing
- `list_voices: true` fetches the live voice catalog on demand

## Install (manual)

Symlink or copy `tts.ts` into pi's global extensions directory:

```
~/.pi/agent/extensions/tts.ts
```

Or register the path in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/path/to/pi-tts/tts.ts"] }
```

Then `/reload` (or restart pi).

## Requirements

- The `tts` binary on PATH (Kokoro/piper-backed neural TTS)
- pi with extension support

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
