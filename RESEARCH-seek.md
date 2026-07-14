# Research: forward- and backward seek in pi-tts

> **Status:** Research only. No code changes. Carried over from a research
> pass on 2026-07-14. Pick up here if revisited.
>
> **Prior mention:** `DEV.md` → "Status / roadmap" → "Phase 2 — OPTIONAL,
> likely never: backward-skip / precise resume (e.g. 'resume −5s'). Requires
> switching from streaming playback to render-to-file (temp WAV + seekable
> player), which adds start-up latency and complexity. Do NOT treat this as
> pending or mandatory work. Only pursue it if the repo owner explicitly asks
> for it in a future session." That prior framing is correct and is the
> starting point for everything below.

---

## 1. Why the current architecture cannot do seek

Read the `tts` binary end-to-end (`/home/johan/.local/bin/tts`, 861 lines,
bash) and trace the two playback paths:

| Speed range | Synthesis | Playback | Seekable? |
|---|---|---|---|
| `0.9–1.2` (default) | `sherpa-onnx-offline-tts-play` callback by callback | PortAudio → ALSA direct | **No.** Audio bytes don't exist until the model emits them. The player is a sink over a callback; there is no file/buffer to seek. |
| `< 0.9` or `> 1.2` | `sherpa-onnx-offline-tts` chunked (50-word chunks, ramping from 12) | `sox tempo` → `aplay -q -t raw` over fd 3 | **No.** Chunks are generated, time-stretched, and piped to `aplay` as raw PCM. `aplay` cannot seek a pipe. |

`sherpa-onnx-offline-tts-play` links against `libasound` (ALSA) and
`portaudio`; playback is via PortAudio's ALSA host API. No seek surface.
The script's own `--help` already hints at the only escape hatch: *"Streaming
playback is smooth up to ~1.8; above that expect pauses between chunks — use
`-o` instead."* Seek needs that same `-o` path.

**Conclusion: seek is not a feature flag — it is a structural change.**

---

## 2. The change: render-to-file + seekable player

For every `tts` call:

1. **Render the full text to a temp WAV first** (blocking, synchronous):
   `tts -o /tmp/tts-XXXX.wav "text" -v af_sarah -s 1.0`. This already exists
   in the `tts` script and works for both Kokoro and Chatterbox voices (the
   Chatterbox path delegates to `tts-cb -o`).
2. **Play that WAV with `mpv`** (v0.41.0 already installed locally) with
   JSON IPC enabled:
   `mpv --idle --no-terminal --input-ipc-server=/tmp/tts-mpv.sock /tmp/tts-XXXX.wav`.
3. The extension opens a `net.Socket` to the socket path and exchanges
   line-delimited minified JSON.
4. Clean up the WAV on stop / skip / barge-in / session_shutdown / process
   exit. Track active paths in a `Set<string>`.

The IPC vocabulary needed is tiny — every command is one line of JSON
terminated by `\n`:

| Need | JSON sent | Returns / events |
|---|---|---|
| Pause | `{"command":["set_property","pause",true]}` | `pause` property event |
| Resume | `{"command":["set_property","pause",false]}` | `pause` property event |
| Seek absolute | `{"command":["set_property","time-pos",12.5]}` | `time-pos` property event |
| Seek relative (skip ±N s) | `{"command":["seek",30,"relative"]}` | `time-pos` property event |
| Get current position | `{"command":["get_property","time-pos"]}` | `{data: 12.5}` |
| Get total duration | `{"command":["get_property","duration"]}` | `{data: 264.0}` |
| Position stream (footer) | `{"command":["observe_property",1,"time-pos"]}` | property-change events |
| Queue next item | `{"command":["loadfile","/tmp/next.wav","append-play"]}` | `end-file` event on prior |
| Stop playback (clean) | `{"command":["stop"]}` | (mpv goes idle) |
| Hard stop (safety net) | `kill(-mpvPid, SIGTERM)` (existing mechanism) | (process group dies) |

The protocol is a single minified-JSON line per message, both directions.
~30 LoC to roll directly on `net.Socket`. See the "npm modules" section for
why no wrapper is worth the dep.

---

## 3. The price tag: first-sound latency

Kokoro is ~3–4× realtime on this hardware. Today, first sound arrives after
the first chunk (~200 ms — first chunk is one short sentence). With
straight render-to-file (Option A below), **first sound = full synthesis
time**:

- 30-word sentence → ~2 s wait
- 200-word paragraph → ~10–15 s wait
- 2000-word article → ~1.5–2 min wait

**This is the deal-breaker most users would feel.** The streaming path is
exactly what makes today's UX feel responsive. Four ways to soften it:

| | A. Pure render-to-file | B. Smart hybrid | C. Background pre-render | D. Render-on-demand |
|---|---|---|---|---|
| Default play | wait, then play | play first chunk from stream, switch to file when ready | play streaming; pre-render full file silently in the background; mark "seekable" when ready | same as today — full streaming |
| First-sound latency | full synth (~10 s for a paragraph) | ~200 ms | ~200 ms | ~200 ms |
| Seek available | immediately | after full synth | after full synth | only after a seek request, then ~5–10 s gap |
| Audio seam | none | yes (small, possibly a click) | optional, on switch | yes (only when user seeks) |
| Complexity | lowest | highest | medium | medium |

**Recommendation: C is the best trade.** Keeps today's instant first sound,
becomes seekable after a few seconds with no UX interruption. Cost is one
extra `tts -o` running in the background for the duration of each playback,
plus a small state machine tracking "file not yet ready" / "file ready,
streaming still active" / "switched to mpv". A is simplest but the UX
regression is immediate. D is acceptable if seek is a rare action.

---

## 4. Knock-on changes (not just "add seek")

Switching the sink from the `tts` process group to `mpv` retunes several
existing mechanisms in `index.ts`. Each one is small individually; together
they make up most of the implementation cost.

1. **Pause/resume.** Today: `SIGSTOP`/`SIGCONT` to the whole process group
   (`signalGroup(pid, "SIGSTOP")` etc.). Tomorrow: `set_property pause`
   over IPC. The `Ctrl+Space` shortcut stays; its handler now writes JSON
   to a socket. `current.paused` becomes "derived from `get_property pause`
   event" rather than "derived from signal we just sent".
2. **Skip/stop/barge-in.** Today: `killGroup(current.pid)`. Tomorrow:
   *send* `{"command":["stop"]}` for a clean exit; the process-group kill
   stays as the safety net the existing code already gets right.
3. **Queue.** Today: a FIFO `Job[]` in JS, started via `spawn("tts", …)`.
   Tomorrow: mpv's *own* playlist, populated by
   `loadfile <path> append-play`. Cleaner, but the JS-side queue must
   mirror it (or the model can never know "is the queue empty?"). The
   `end-file` event drives dequeuing.
4. **Grace window.** Today: 500 ms `setTimeout` after `spawn` to catch
   `voice not found` early. Tomorrow: same 500 ms, but the failure
   surface changes — `tts -o` can fail (bad voice, OOM, disk full), and
   `mpv` can fail (no audio device). Both need handling.
5. **Footer status.** The current footer says `▶ +N` / `⏸ +N`. With IPC
   you can show `▶ 1:23 / 4:56` for free (one `observe_property
   time-pos` + one `get_property duration`). Throttle: events come 1× per
   IPC roundtrip — could be 10/s; debounce to avoid UI churn.
6. **Temp file cleanup.** The big one. Every play call leaves a WAV in
   `/tmp` (up to ~80 MB for a 30-min article). Need: a `Set<string>` of
   active paths, cleanup on `stopAll`, `session_shutdown`, `process.exit`
   (already wired via the `globalThis.__piTtsExitHook` pattern), and a
   periodic sweep for orphans. The `tts` script already does similar
   tempdir hygiene (`mktemp -d …; trap "rm -rf '$tmpd'" EXIT`) — copy
   that pattern.
7. **Tool description & promptGuidelines.** The current tool description
   says *"Playback runs in the background and does not block"*. With
   render-to-file (Option A), the tool *does* block — for the full synth
   time — before it returns. Either update the description to be honest
   ("speaks in the background once synthesis completes; ~Xs for typical
   sentences"), or implement C/D and keep the current wording.
8. **New tool params + slash commands.** Per the project's hard rules
   (CLI flag syntax lives in `index.ts` only), add typed parameters
   `skip_back: number` and `skip_forward: number` (or a single
   `seek: number` with sign). Add `/tts-skip-back` and `/tts-skip-forward`
   slash commands for the user-typed path (zero LLM round-trip, like
   today's `/tts-pause`).

---

## 5. npm modules (audited)

I checked the obvious candidates. None adds much over a hand-rolled IPC
client, and adding a dep for a thin wrapper is a poor trade — the rest of
this extension uses zero runtime deps.

| Module | What it does | Verdict |
|---|---|---|
| `mpv-ipc` | "Dumb" 1:1 JSON-IPC translator. ~7 KB. | **Best library option** if a dep is wanted. Minimal wrapper, no observer pattern, no flag management. |
| `node-mpv` | Higher-level wrapper: EventEmitter, `pause()`, `seek(s)`, `getTimePosition()`, `time_update`. | Works, but pulls in a lot of surface we don't need (audio flags, restart, idle, etc.). |
| `mpv` (Porsager) | Even smaller than `mpv-ipc`. | Equivalent, slightly less popular. |
| **Hand-rolled `net.Socket`** | The protocol is one minified-JSON line per command. | **Recommended.** ~30 LoC, zero deps. Matches the rest of the extension. |

Other things I checked and rejected:
- `play-sound` — no seek.
- `node-wav-player` — no seek.
- `soundplayer` — no seek, no streaming.
- `groove` — port-audio + libgroove, but abandoned.
- `webaudio-node` / `play-pcm` — Web-Audio-style sample buffers; would
  require decoding the WAV ourselves. Pure overhead vs. `mpv` which
  decodes WAV natively.

`ffplay` is on the system but has **no programmatic control** — its seek
keys are interactive only, no IPC socket. Not usable for an extension.

---

## 6. Risks worth flagging

- **Audio-stitching at the streaming→mpv handoff (Options B/C).** The
  first chunk is generated by a different process than the full file.
  Even if the audio bytes are identical, the handoff is a few ms gap
  (different audio backends: PortAudio/ALSA → mpv → ALSA). The `tts`
  script's sox path already addressed a related issue ("Pre-generate
  the first TWO chunks concurrently") — same trick could apply.
- **Disk / memory pressure.** Long playback = large WAV. `/tmp` is
  usually tmpfs on Linux (RAM-backed); a 200 MB article eats 200 MB of
  RAM. Could leak in a long session. Use `$XDG_RUNTIME_DIR` (also
  tmpfs) or `$TMPDIR` if it's a real disk, and cap WAV size or sweep
  periodically.
- **Chatterbox / Swedish voices.** `tts -o` for Chatterbox delegates to
  `tts-cb -o` — same temp-file path, same end result. No regression. The
  `-s/--speed` rejection for Chatterbox is still handled by the existing
  capability gating in `index.ts` (see `FIXES.md`).
- **macOS.** `mpv` is not installed by default. The current `tts`
  binary's audio is ALSA/PortAudio on Linux and probably CoreAudio on
  macOS. `mpv` abstracts this — should "just work" — but the extension
  must detect mpv's presence and either fall back to the streaming
  path or error clearly. `ffplay` is on macOS by way of ffmpeg
  installations but has no IPC.
- **Process group / orphan handling.** The current code has careful
  `SIGCONT`-before-`SIGTERM` for paused groups; with mpv the analog is
  `{"command":["quit"]}` then `kill`. The safety net for paused groups
  on `process.exit` is critical (already wired via
  `globalThis.__piTtsExitHook`) and must be preserved.
- **Edge cases.** "Seek past zero" / "seek past end" — mpv clamps, but
  test. `set_property time-pos` while paused — works, but verify the
  resume-on-seek semantics. Seek to a position before the very first
  audio sample — also clamped, no crash, but check the footer reads.

---

## 7. Files & references in this repo

- `index.ts` — the extension. See `startJob`, `startWithGrace`,
  `signalGroup`, `killGroup`, `stopAll`, `pausePlayback`,
  `resumePlayback`, `skipPlayback`, the `transport` array, and the
  `session_shutdown` / `process.exit` safety nets — all of these touch
  the streaming model directly and need to be retuned.
- `DEV.md` — Phase 2 framing (quoted in the header above).
- `FIXES.md` — Chatterbox pace/speed history (relevant if the new
  pipeline should also gracefully degrade for Chatterbox voices).
- `tts-llm-toolcalling.md` — why the model must not see the `tts` CLI
  flag syntax. Same rule applies to any new `seek`/`skip` params: the
  friendly name lives in `index.ts` only, never in tool descriptions.
- `IMPLEMENTATION-PLAN-voice-catalog.md` — the prior research →
  implementation template. Same shape works for seek.

---

## 8. Cost / effort estimate

- **Option A (render-to-file, no hybrid):** ~½ day. Two-step spawn
  (`tts -o` then `mpv`), IPC client, retune pause/resume/skip/stop to
  IPC, temp-file cleanup, footer position display, update tool
  description. **UX regression: every play call waits full synth time.**
- **Option C (background pre-render + smart handoff):** ~2 days. All
  of A, plus a state machine for "streaming → mpv switch", the
  pre-render background process, the audio-stitching click mitigation,
  and tests for the handoff timing.
- **Option D (render-on-demand, stream by default):** ~1 day. Keep
  streaming; on first seek, kill the stream, render the file,
  `mpv` at the requested offset. Five-to-ten-second gap on first
  seek, but normal playback stays fast. Acceptable if seek is rare.

---

## 9. Decision points (open)

1. Which option (A / C / D)? Drives ~all of the implementation cost.
2. mpv-only, or do we need a fallback? macOS doesn't ship mpv; ffplay
   is insufficient.
3. New tool param shape: `seek: <signed_seconds>`, or
   `skip_forward: <seconds>` + `skip_back: <seconds>`, or
   `seek_to: <seconds>` + `skip_by: <signed_seconds>`? (Friendly-name
   rule still applies — none of these need to expose `tts` or `mpv`.)
4. Footer: keep today's `▶ +N`, upgrade to `▶ 1:23/4:56`, or add a
   configuration toggle?
5. New slash commands: `/tts-skip-back` / `/tts-skip-forward`?
   Configurable amount (e.g. `/tts-skip-forward 30`)?
6. Are we willing to block the tool call for the full synth time on
   render-to-file paths, or do we want the pre-render approach (C/D)?
