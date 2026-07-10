# Third-party notices

Claude Code Nest redistributes the following third-party artifacts in its
repository and (where noted) in the packaged VSIX. Each artifact's license text
ships alongside it (or inline in its header) as noted below. Any future
vendored asset added under `media/` or `src/**/vendor/` must be enumerated here
with its license text, source URL, provenance (how the exact bytes were
produced), and a checksum recorded in DECISIONS.md.

## Newsreader (font)

- File: `media/fonts/newsreader-600-latin.woff2` (weight 600, latin subset,
  23,876 bytes, sha256
  `05c91a26d19a61eafe7ce8e0b77eff3fd279ce994dc89f432f4cd06784935e84`)
- Ships in the repository and in the VSIX.
- Copyright 2017 The Newsreader Project Authors
  (https://github.com/production-type/Newsreader)
- License: SIL Open Font License, Version 1.1. The full license text ships in
  `media/fonts/OFL.txt` (included in the VSIX next to the font file).
- Provenance and subsetting: the file is byte-identical (sha256 re-verified
  2026-07-09) to the latin-subset woff2 Google Fonts serves for
  `Newsreader:wght@600` (Newsreader v26), i.e. the subset was produced by the
  Google Fonts pipeline, not locally. Source URL at verification time:
  https://fonts.gstatic.com/s/newsreader/v26/cY9qfjOCX1hbuyalUrK49dLac06G1ZGsZBtoBCzBDXXD9JVF438wpojwC-ZF.woff2
  (resolved from https://fonts.googleapis.com/css2?family=Newsreader:wght@600,
  the `/* latin */` unicode-range block). The font is used under the family
  name "Newsreader" only, unmodified beyond Google Fonts' own subsetting.

## MiniSearch (JavaScript library)

- File: `src/search/vendor/minisearch.js` (v7.2.0, vendored verbatim from the
  published npm UMD dist; ships compiled at `out/search/vendor/minisearch.js`)
- Ships in the repository and in the VSIX.
- Copyright 2022 Luca Ongaro (https://github.com/lucaong/minisearch)
- License: MIT. The full license text is carried inline in the vendored file's
  header comment, which ships in both the repo and the VSIX copy.

## React and ReactDOM (design mockup runtime)

- Files: `media/design/ChatSidebar.html` embeds `react.production.min.js` and
  `react-dom.production.min.js`, both version 18.3.1, as gzip+base64 resource
  blobs inside the self-contained design-handoff mockup. Each embedded copy
  retains its original `@license React` MIT header inside the decompressed
  bytes.
- Ships in the repository only: the VSIX excludes it (`media/design/**` in
  `.vscodeignore`), and the extension never loads it at runtime; it is a
  design reference document.
- Copyright (c) Facebook, Inc. and its affiliates.
- License: MIT (https://github.com/facebook/react/blob/main/LICENSE).

MIT license text (applies to MiniSearch, React, and ReactDOM above, per their
respective copyright holders):

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
