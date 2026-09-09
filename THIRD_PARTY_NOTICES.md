# Third-party notices

PDF Edna is MIT-licensed (see `LICENSE`). The built extension bundles the
following third-party software, each under its own license.

| Component                                                  | License                   | Source                                             |
| ---------------------------------------------------------- | ------------------------- | -------------------------------------------------- |
| pdf.js (`pdfjs-dist`) — rendering, text extraction         | Apache-2.0                | https://github.com/mozilla/pdf.js                  |
| Comlink — worker RPC                                       | Apache-2.0                | https://github.com/GoogleChromeLabs/comlink        |
| pdf-lib — PDF object model and writing                     | MIT                       | https://github.com/Hopding/pdf-lib                 |
| fontkit (`@pdf-lib/fontkit`) — font parsing and subsetting | MIT                       | https://github.com/Hopding/fontkit                 |
| Gelasio — bundled fallback serif face                      | SIL Open Font License 1.1 | `public/fonts/fallback/LICENSE-Gelasio.txt`        |
| Liberation Sans — bundled fallback sans face               | SIL Open Font License 1.1 | `public/fonts/fallback/LICENSE-LiberationSans.txt` |

The full license texts for the npm packages ship in `node_modules/<package>/`
after `npm install` and are reproduced in the source repositories linked above.

## Trademarks

The name **PDF Edna**, the extension icons in `public/icons/`, and the promo
assets produced by `scripts/promo*.mjs` identify this project's Chrome Web
Store listing. They are not covered by the MIT license. Forks and
redistributions must use a different name and icon.
