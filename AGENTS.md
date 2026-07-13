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
- Develop on the `live` branch. `pi install ...@live` installs the `live`
  branch; publish the stable `main` snapshot with `git push origin live:main`.

## Deployment & the edit loop (read this first)
pi does **not** load this folder. `pi install ...@live` clones the repo into
pi's own managed directory and runs the extension from **there**:

    ~/.pi/agent/git/github.com/ekenberg/pi-tts/index.ts   <-- what pi actually runs

Edits made here are invisible to pi until they reach that clone. Loop:

1. Edit `index.ts` in this folder.
2. Commit and push to live:  `git commit -am "..." && git push origin live`
3. Re-clone so pi's copy updates:  `pi update --extensions`
4. Test in a **fresh** pi session (a running session may cache the old tool
   description until the re-clone).
5. When happy, publish stable:  `git push origin live:main`

**`/reload` is not enough by itself.** It only re-reads pi's *already-installed
clone*. If you edited this source folder, `/reload` sees nothing new until steps
2–3 push and re-clone. If a test shows your change is missing, inspect the
clone's `index.ts` above — not this file — to see what's actually running.

(Alternative: edit the clone directly and `/reload`, then `git pull` here to
mirror. Either way, changes must reach the clone to run.)

## Hard rules
- Keep `tts` CLI flag syntax in `index.ts` only — never in prompts or docs as instructions.
- Keep README/DEV claims consistent with the actual install state in `~/.pi/agent/settings.json`.
