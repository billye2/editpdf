# Contributing

Thanks for looking. This is a small, casually maintained project, so expect
replies in days rather than hours.

## Setup

```sh
npm install
npm run gen:samples   # generates the test PDFs (not committed)
npm run dev           # Vite dev server for the viewer
npm run build         # writes dist/ — load it unpacked at chrome://extensions
```

Gates that CI runs on every push and pull request:

```sh
npx tsc --noEmit
npm run lint
npm test
npm run test:e2e
```

## Reporting a bug

Most bugs come from a specific PDF. Attach one only if you are sure it
contains nothing private; otherwise describe how it was produced (which app,
which fonts, scanned or born-digital) so it can be reproduced with a generated
sample. Never post someone else's document.

## Pull requests

- Keep one change per PR and add or update a test under `test/` or `e2e/`.
- The README's "How it works" and "Known limitations" sections must stay true
  after your change; update them if behavior moves.
- All PRs are reviewed by the maintainer before merge.

## Security

If you find a way for the extension to leak document content or reach the
network, email the maintainer privately rather than opening a public issue.
