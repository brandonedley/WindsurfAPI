# src/vendor — vendored third-party code

Code copied into this repo (not pulled from npm) so the project keeps **zero npm
runtime dependencies** while still doing real image downscaling for vision inputs.

## jpeg-js (`jpeg-js/`)

- **Source:** [jpeg-js](https://github.com/jpeg-js/jpeg-js) v0.4.4 (package license BSD-3-Clause,
  © 2014 Eugene Ware — see `jpeg-js/LICENSE`, retained verbatim).
- **Component licenses (both retained inline at the top of each file):**
  - `decoder.js` — Apache-2.0, © 2011 notmasteryet.
  - `encoder.js` — BSD-3-style, © 2008 Adobe Systems Incorporated.
- **Why vendored:** baseline JPEG decode + encode with no native binaries. This is the
  same battle-tested codec Jimp itself uses under the hood; vendoring it (instead of
  hand-writing a DCT codec) keeps risk low while removing the npm dependency.
- **Local changes:** converted the trailing UMD `module.exports = fn` blocks to ESM
  `export default fn`; the encoder now always returns a Node `Buffer`. No algorithm
  changes.
- **API:** `decode(buffer, {useTArray:true}) -> {width,height,data:RGBA}` ·
  `encode({data:RGBA,width,height}, quality) -> {data:Buffer}`

## png.js (`png.js`)

- **Original** to this project. Minimal pure-Node PNG **decoder** (8-bit
  grayscale / RGB / RGBA, non-interlaced) built on the built-in `node:zlib`.
  Unsupported variants throw so the caller falls back to a safe passthrough.
  We only decode PNG (re-encoding always targets JPEG), so no PNG encoder is included.
