---
name: ship
description: EditPDF wrap-up ritual — sweep docs/HANDOFF for staleness, update memory, commit, check/merge PRs, push, run the release (bump+build+zip+tag), verify CI, report the store zip. Use when the user says "ship", "prepare release", "update docs/memory/handoff and release", or "commit, push, release".
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
- Push, then confirm the CI run for the pushed commit succeeds
  (`gh-axi run list`, poll with an until-loop; never assume).

## 5. Release

- `npm run release` — it verifies a clean tree, type-checks, runs all tests,
  bumps the decimal-rollover version, builds, zips `dist/` into
  `release/editpdf-v<X.Y.Z>.zip`, commits, tags, pushes.
- Wait for the release commit's CI to go green.
- Report: new version, zip path (the Chrome Web Store upload), and CI status.

If any gate fails (type-check, tests, CI), stop and fix before releasing —
never tag a red build.
