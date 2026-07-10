# AGENTS.md

pi-tts — a pi extension that wraps the local `tts` CLI as a typed `tts` tool.

This repo is a pi *package*; it was not hand-written by the owner (see the
transparency note in README.md).

## Orientation
- `index.ts` — the extension. Friendly params in, `tts` CLI flags out; text is sent over stdin.
- `package.json` — pi package manifest (`pi.extensions: ["./index.ts"]`).
- `README.md` — install + usage for users.
- `DEV.md` — **read this before changing anything**: repo layout, branches (`main`/`live`), and the edit loop.

## Conventions
- Install/develop on the `live` branch (`pi install ...@live`); publish to `main` with `git push origin live:main`.
- After editing, `/reload` pi (or `pi update --extensions` for a clean re-clone).

## Hard rules
- Keep `tts` CLI flag syntax in `index.ts` only — never in prompts or docs as instructions.
- Keep README/DEV claims consistent with the actual install state in `~/.pi/agent/settings.json`.
