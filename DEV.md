# Development

Read this before changing the `tts` extension. It explains the repo layout and
the day-to-day loop.

## Status / roadmap

- **Phase 1 — DONE & validated:** background playback, barge-in, queue, pause/
  resume/skip/stop/status (tool params + `/tts-*` slash commands), orphan-safe
  process-group kills, calibrated pace presets, bare voice-name resolution, and
  the `| TTS: ▶ +N` footer indicator.
- **Phase 2 — OPTIONAL, likely never:** backward-skip / precise resume (e.g.
  "resume −5s"). Requires switching from streaming playback to render-to-file
  (temp WAV + seekable player), which adds start-up latency and complexity.
  **Do NOT treat this as pending or mandatory work.** Only pursue it if the
  repo owner explicitly asks for it in a future session.

## Repo layout — two repos, one remote

- **Source repo (this directory):** `/home/johan/srv/syncthing/projects/pi-tts`
  The original `git init`; edit here OR in the clone below — the clone is what pi loads at runtime.
- **pi's managed clone:** `~/.pi/agent/git/github.com/ekenberg/pi-tts/`
  Created by `pi install`. This is what pi actually loads at runtime.

Both track the same GitHub remote (`git@github.com:ekenberg/pi-tts.git`).

## Branches

- `main` — stable snapshot.
- `live` — active development branch. `pi install ...@live` checks out `live`,
  so the clone pi loads is always on `live`. `@live` is just a branch name,
  not a pi keyword.

## Install (idempotent)

```bash
# SSH (reliable on this machine)
pi install git:git@github.com:ekenberg/pi-tts@live
# or, on a machine with git credentials for the public repo:
pi install git:github.com/ekenberg/pi-tts@live   # HTTPS

/reload            # in a running pi session
```

Clean re-clone if needed: `pi update --extensions`.

## The edit loop

Two repos track the same remote (see Repo layout). Pick ONE place to edit.

**Recommended — edit the source repo (this folder), then push + re-clone:**
1. Edit `index.ts` here.
2. `git commit -am "..." && git push origin live`
3. `pi update --extensions` — re-clones `live` into pi's managed copy.
4. Test in a fresh pi session.
5. Publish stable: `git push origin live:main`

**Alternative — edit pi's managed clone directly:**
1. Edit `~/.pi/agent/git/github.com/ekenberg/pi-tts/index.ts`
2. `/reload` in pi, then test (e.g. "say hello using af_sarah"). `/reload`
   re-reads the clone, so no reinstall is needed *for this path*.
3. `cd` into the clone, `git commit -am "..." && git push`, then `git pull`
   here to mirror back into this source repo.

**Gotcha that bit us:** `/reload` only re-reads the *installed clone*. If you
edited this source folder, `/reload` shows nothing new until you push AND
`pi update --extensions` re-clones. Always verify against the clone's
`index.ts`, not this file.

## Publishing changes to `main`

`live` is what's installed. To refresh the stable `main` snapshot:

```bash
git push origin live:main
```

## Gotchas

- **HTTPS clone failed** with "Authentication failed" / "Password authentication
  is not supported": this machine had a bad cached git credential and the repo
  was private at first. Fixes: use the SSH source form above, or make the repo
  public and fix the credential helper.
- **`@live` must exist on the remote** or install fails with
  `pathspec 'live' did not match`. Create it with
  `git checkout -b live && git push -u origin live`.
- Editing this source repo does NOT affect pi until you push and the clone
  picks it up (`pi update --extensions`, or `git pull` in the clone).
- The `tts` binary itself must be on PATH; this extension only wraps it.
