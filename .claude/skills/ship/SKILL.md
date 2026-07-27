---
name: ship
description: EditPDF wrap-up ritual — sweep docs/HANDOFF for staleness, update memory, commit, check/merge PRs, push, run the release (bump+build+zip+tag), hand over the reloadable dist/ build immediately, verify CI in the background, report the store zip. Use when the user says "ship", "prepare release", "update docs/memory/handoff and release", or "commit, push, release".
---

Run the EditPDF ship ritual. Steps, in order — skip a step only when there is
genuinely nothing for it to do, and say so.

## 1. Docs staleness sweep

Compare recent commits (`git log --oneline` since the last `Release v*` tag)
against the docs and fix drift:

- `docs/HANDOFF.md` — test count (`npx vitest run` total), architecture
  diagram (new engine/viewer files), "What it does" bullets, invariants for
  any new hard-won gotcha. The version line points at package.json — keep it
  that way, never hardcode a version.
- `README.md` — "What it does" / "Using it" / limitations bullets for new or
  changed behavior. Watch for behavior lines the change made FALSE (the
  overflow-policy line once described removed behavior — that class of bug).
- `docs/manual-checklist.md` — add a check line for each new user-visible
  behavior or fixed bug.
- `docs/store-listing.md` + `PRIVACY.md` — only when permissions or data
  storage changed.

## 2. Memory

Update the auto-memory project file (editpdf-project.md): version, new
capabilities, new invariants/gotchas, settled product decisions. Update — do
not duplicate; keep it terse.

## 3. Commit

- If the working tree mixes unrelated feature batches, commit them as
  separate logical commits (hunk-level splitting if needed); otherwise one
  commit with a message explaining WHY, not just what.
- NEVER commit user PDFs: `test/*.pdf` is gitignored for a reason — check
  `git status` for surprises before any `git add -A`.
- End commit messages with:
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

## 4. Merge + push

- `gh-axi pr list` — if PRs are open, review and merge the green ones (ask
  the user about anything non-trivial). Report "no PRs" otherwise.
- **`npm run build` right after committing** — `dist/` must always reflect
  the just-committed code, and tell the user so: reload PDF Edna in
  `chrome://extensions` (↻) to test the changes NOW, without waiting for CI
  or the release. (A stale `dist/` once made the user think a shipped fix
  didn't work.)
- Push, then confirm the CI run for the pushed commit succeeds
  (`gh-axi run list`, poll with an until-loop in the background
  (`run_in_background`); never assume). Don't make the user sit through this
  poll — the local gates (type-check, tests, lint) already passed, so keep
  going; just don't START `npm run release` (which tags) until this run is
  green — never tag a red build.

## 5. Release

- `npm run release` — it verifies a clean tree, type-checks, runs all tests,
  bumps the decimal-rollover version, builds, zips `dist/` into
  `release/editpdf-v<X.Y.Z>.zip`, commits, tags, pushes.
- **The moment `npm run release` succeeds, tell the user the extension is
  ready to test**: `dist/` now holds the exact released build — reload PDF
  Edna in `chrome://extensions` (↻) and it's live; no dev server needed.
  Deliver this message immediately, BEFORE waiting on any CI run.
- Then verify the release commit's CI in the background (same until-loop
  pattern) and follow up with: new version, zip path (the Chrome Web Store
  upload), and CI status. If that CI run fails, fix it and say clearly
  whether the failure affects the built extension the user is already
  testing or was test/infra-only.

If any pre-tag gate fails (type-check, tests, the pushed commit's CI), stop
and fix before releasing — never tag a red build.
