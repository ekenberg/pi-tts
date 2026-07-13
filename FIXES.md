# Fix Log

Tracking issues surfaced during tts testing. Some fixes are external to this
project (marked `external`).

## Open items

- [x] **Swedish voice was undocumented, not missing** (internal fix done; binary `list_voices` fix external)
  - Correction: Swedish voices DO exist — `sf_*` = Swedish female, `sm_*` = Swedish
    male (Chatterbox-backed, e.g. `sf_astrid`, `sm_allan`). Earlier testing wrongly
    claimed "no Swedish voice" / "Allan is not Swedish"; that was a documentation
    gap, not a capability gap.
  - Two gaps found:
    - `s=Swedish` convention was absent from pi-tts `voice` param description.
      **Fixed internally** — added `s=Swedish` to the lang list in `index.ts`
      (kept `f`=French, `m`=male; `sf_`/`sm_` now resolve correctly).
    - The `tts` binary's `list_voices` does not surface Swedish among the other
      languages — **user fixing externally**.

- [ ] **`pace`/`speed` rejected by Chatterbox voices**
  - `tts` errors with `-s/--speed not supported for chatterbox voices` when a
    Chatterbox voice is used (`sf_*` / `sm_*`, e.g. `sf_astrid`, `sm_allan`).
    The `slow`/`fast` pace presets (and any `speed` value) therefore fail for
    those voices.
  - Possible fixes: the extension could detect Chatterbox voices and skip the
    `-s` flag (or warn), or document that pace is Kokoro-only. Backend-side
    (tts-cb) this may be a hard limitation.

- [x] **No instruction to infer voice from requested language (applied to `index.ts`)**
  - Fresh-session test: the local model read Swedish text with the English
    default voice (`af_kore`). The model's self-report flagged four things:
    1. naming scheme lacked `s=Swedish` — **already present in the dev working
       tree** (`/home/johan/srv/syncthing/projects/pi-tts/index.ts`, line 352)
       BUT pi does not read that file. It loads its own git clone at
       `~/.pi/agent/git/github.com/ekenberg/pi-tts/index.ts` (from
       `git@github.com:ekenberg/pi-tts@live`), which still had the old scheme.
       `/reload` does NOT help — it only re-reads the already-loaded clone, not
       the syncthing tree. Remedy: propagate the edit into the loaded clone
       (commit + `git push origin live` then `pi update --extensions`, or patch
       the clone file directly for a quick local test).
    2. Chatterbox Swedish voices (`sm_*`/`sf_*`) are in `list_voices` but not in
       the tool instructions — **addressed by the `s=Swedish` naming-scheme
       entry**; `sm_`/`sf_` now resolve as Swedish.
    3. default voice is English, so non-English text sounds wrong — the root
       cause of the bad Swedish reading.
    4. no instruction to infer voice from the requested language — **the actual
       missing behaviour**.
  - Fix applied: new `promptGuidelines` bullet — "Match the voice to the language
    being spoken... pick a voice of that language... Do not read non-English text
    with the English default voice." Covers points 3 & 4.
  - Internal to the project (`index.ts`); pairs with the `s=Swedish` entry.

- [x] **No guidance for TTS-friendly text rewriting (applied to `index.ts`; may reword later)**
  - Observed: during testing the model rewrote source text before sending it to
    `tts` — e.g. expanded `MOE` → "mixture of experts", `1M` → "one million",
    `ASR` / `TTS` spelled out, `95B` → "95 billion". This produced *better*
    speech (neural TTS mangles acronyms/bare digits), but it was the model's
    own inference. The extension (`index.ts`) passes `text` to the binary
    verbatim over stdin and contains no such instruction in its `promptGuidelines`
    (those only cover *when* to call and *which* control flags to use).
  - Proposal: add a short, low-bloat guideline to the tool so the behaviour is
    deliberate and consistent — not free modelling:
    - **Default = "speakable" rewrite mode:** a few sentences telling the
      model to lightly normalize prose for spoken delivery *without altering
      meaning* — expand common acronyms/digits the TTS would misread, fix
      punctuation/clipping, keep the wording close to source. Goal: fluent
      listening, not summarization.
    - **Opt-out = verbatim:** a phrase like `read this verbatim` / `read exactly
      as written, no alterations` / `tts - verbatim` makes the model send the
      raw text unchanged.
    - **Prompt-engineering constraints (important):**
      - Must be understood by *weak* models too, so phrase it concretely with
        examples rather than abstractly; avoid ambiguous words like "improve".
      - Keep it *brief* — system prompts bloat fast, so this should be 2–4
        sentences plus one verbatim example, not a style manual.
      - State the default explicitly so lesser models don't skip the rewrite,
        and state the opt-out explicitly so they can disable it.
  - **Applied `promptGuidelines` text (first draft; kept for now, may reword later):**
    > Before speaking, lightly rewrite the text into natural speech, unless the
    > user asked for it verbatim. Expand abbreviations and bare numbers the TTS
    > would mispronounce (e.g. 'MOE' -> 'mixture of experts', '1M' -> 'one
    > million', '95B' -> '95 billion') and fix broken punctuation. Do NOT change
    > the meaning, add facts, or summarize. If the user says "verbatim",
    > "exactly as written", or "no alterations", send the text unchanged.
    - Note: an assertive / dim-model-safe reword (lead with "Rewrite ... UNLESS
      verbatim"; explicitly "remove *, _, #, backticks, path slashes") was
      drafted during testing but the simpler first-draft above was preferred
      and is what shipped. Can be revisited later if weak-model behaviour
      warrants it.
  - This is **internal** to the project (lives in `index.ts` `promptGuidelines`),
    not a backend/flag change.
