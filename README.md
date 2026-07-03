<!-- markdownlint-disable MD041 -->
# DRTV in English

Watch DR TV with English subtitles via a Manifest V3 browser extension
(Chrome + Firefox) that injects translated cues into DR's own player.
Bring your own LLM API key — nothing runs on a server.

______________________________________________________________________
[![License](https://img.shields.io/github/license/saattrupdan/drtv_in_english)](https://github.com/saattrupdan/drtv_in_english/blob/main/LICENSE)
[![LastCommit](https://img.shields.io/github/last-commit/saattrupdan/drtv_in_english)](https://github.com/saattrupdan/drtv_in_english/commits/main)

Developer:

- Dan Saattrup Smart (<saattrupdan@gmail.com>)

## How it works

1. Detects when you open an episode on `dr.dk/drtv`.
2. Sniffs DR's Danish `.vtt` subtitle file from the network.
3. Translates the cues with your chosen LLM provider.
4. Injects the English cues as a native `TextTrack` on DR's `<video>`.

No backend, no proxy, no media downloading. DR's player handles
playback; the extension only adds an extra subtitle track.

## Layout

```
manifest.chrome.json
manifest.firefox.json
build.mjs                 # esbuild → dist/chrome and dist/firefox
src/
  background/             # service worker: vtt-sniffer + vtt-parser + translator
  content/                # menu + track injector
  options/                # provider/key form
  shared/                 # types, episode-id helpers, storage wrapper
spike/                    # Phase 0 single-file spike (kept for reference)
icons/
```

## Screenshots

![Options page](package/assets/drtv-in-english-options-chrome.jpg)
*Options page — choose your LLM provider and enter your API key*

![Subtitle menu](package/assets/drtv-in-english-subs-menu-chrome.jpg)
*Three-way Off / Dansk / English menu injected into DR's player*

![English subtitles](package/assets/drtv-in-english-subs-chrome.jpg)
*English subtitles rendering over the video*

## Develop

```sh
npm install
npm run build      # one-shot: produces dist/chrome and dist/firefox
npm run watch      # rebuild on save
npm run package    # build, then zip each target into dist/ for store upload
npm run typecheck  # tsc --noEmit
```

`npm run package` produces three zips in `dist/`:

- `drtv-in-english-chrome-<version>.zip` — what the Web Store accepts
  directly.
- `drtv-in-english-firefox-<version>.zip` — AMO accepts this and
  re-signs it as an XPI on submission.
- `drtv-in-english-source-<version>.zip` — raw source AMO requires for
  bundled add-ons (no `dist/` output or minified code).

Sourcemaps are excluded from the packed extensions. Version is bumped in
`package.json` only; `build.mjs` injects it into each manifest at build
time.

### Load in Firefox

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**.
2. Pick `dist/firefox/manifest.json`.
3. Open a DRTV episode.
4. Click DR's subtitle button → pick **English** to translate the
   episode. The status pill in the bottom-right shows progress.
5. DevTools → Browser Console to see `[drtv-en/...]` logs from both
   the content script and the background script.

> If the first English click reports *"No Danish VTT seen yet"*, pick
> **Dansk** first. That makes DR's player fetch the subtitle file, the
> background sniffer captures it, and then English works on the next
> click.

### Load in Chrome

1. `chrome://extensions` → toggle **Developer mode**.
2. **Load unpacked** → `dist/chrome`.
3. Same verification flow as Firefox.

## What's shipped

- Background service worker:
  - `webRequest` sniffer for `*.vtt` on `*.dr.dk` (`vtt-sniffer.ts`).
  - VTT parser with CRLF → LF normalisation (`vtt-parser.ts`).
  - Real LLM adapters for Anthropic, OpenAI, Gemini, ALX (the
    default), and any OpenAI-compatible endpoint (incl. local models).
  - Per-tab port lifecycle with cancel-on-disconnect.
  - IndexedDB cache keyed by `(episodeId, sourceVttHash)`.
- Content script:
  - Three-way Off / Dansk / English menu hooked into DR's existing
    subtitle button (sibling "EN" pill as fallback).
  - Single English `TextTrack` per `<video>`, cleared on cancel.
  - Status pill showing `Translating subtitles to English… N%`.
  - SPA navigation handling between episodes within DRTV.
- Options page: provider, endpoint, model, API key persisted to
  `chrome.storage.local`. Cache-size readout and clear-cache button.

## What's deferred

- Overlay subtitle renderer (Phase 0 confirmed native `TextTrack`
  works; we keep the spec but don't ship the renderer until a DR
  build masks the native track).

## Install

- **Firefox** — [DRTV in English on Firefox Add-ons](https://addons.mozilla.org/en-GB/firefox/addon/drtv-in-english/)
- **Chrome** — [DRTV in English on the Chrome Web Store](https://chromewebstore.google.com/detail/drtv-in-english/fahnnmmhloooagbgfmmdcmfbipiapedb)

The build script produces store-ready zips via `npm run package`.

## Contribute

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the
[code of conduct](./CODE_OF_CONDUCT.md).
