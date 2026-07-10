# Development

Read this before changing the `tts` extension. It explains the repo layout and
the day-to-day loop.

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

1. Edit the clone (what pi loads):
   `~/.pi/agent/git/github.com/ekenberg/pi-tts/index.ts`
2. `/reload` in pi, then test (e.g. "say hello using af_sarah").
   No reinstall needed — `/reload` re-reads the clone.
3. Repeat until happy.
4. Commit & push from the clone:
   `cd ~/.pi/agent/git/github.com/ekenberg/pi-tts && git commit -am "..." && git push`
5. Mirror into this source repo: `git pull` here (this dir also tracks origin).
   Or commit/push from here instead — both track `origin`; pick one place.

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
