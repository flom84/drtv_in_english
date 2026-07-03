# AGENTS.md

Orientation for AI agents working in this repo.

## What this project is

**DRTV in English** — a Manifest V3 browser extension (Chrome + Firefox) that injects
translated English subtitles into DR's own DRTV player.

The extension is the entire product:

- Content script hooks DR's subtitle button on `dr.dk/drtv/*`.
- Background service worker sniffs the Danish `.vtt`, batches cues, calls the user's
  chosen LLM provider, and streams English cues back.
- English cues are appended to a native `TextTrack` on DR's `<video>`.
- Per-user API key in `chrome.storage.local`. Per-episode translation cache in
  IndexedDB.

No backend, no Docker, no media handling. DR's player handles playback.

## Repo layout

```
manifest.chrome.json
manifest.firefox.json
build.mjs                 # esbuild → dist/chrome and dist/firefox
package.json
tsconfig.json
src/
  background/             # service worker: vtt-sniffer + vtt-parser + translator
  content/                # menu + track injector
  options/                # provider/key form
  shared/                 # types, episode-id helpers, storage wrapper
icons/
```

## Key files to read first

1. [`README.md`](README.md) — what's shipped, what's deferred, how to load in each
   browser
2. `manifest.chrome.json` / `manifest.firefox.json` — permissions and entry points
3. `src/background/` — service worker, VTT sniffer, parser, translator
4. `src/content/` — DR-player DOM hooks and the three-way Off/Dansk/English menu

## Common commands

| Task                     | Command             |
| ------------------------ | ------------------- |
| Install deps             | `npm install`       |
| Build (chrome + firefox) | `npm run build`     |
| Watch / rebuild on save  | `npm run watch`     |
| Typecheck                | `npm run typecheck` |
| Package for stores       | `npm run package`   |

## Build artifacts: `dist/` vs `package/`

- **`dist/`** is throwaway build output (gitignored). `npm run build` writes the
  unpacked extensions to `dist/chrome` and `dist/firefox`; `npm run package` also drops
  store zips in `dist/`. **Load `dist/` for dev** (Load unpacked / Load Temporary
  Add-on).
- **`package/`** holds the _committed_ store artifacts only: `package/zips/` (the exact
  zips submitted to the stores), `package/assets/` (screenshots), `package/submission/`
  (listing text, permission justifications, source-submission notes).
- **Do NOT commit `package/chrome/` or `package/firefox/`** — those unpacked build trees
  are gitignored. They used to be committed and drifted out of sync with `dist/`,
  causing "fixed it but it's still broken" confusion (a stale tree was being loaded).
  Build to `dist/`; copy zips into `package/zips/` for the release record.

## Updating the version

Bump the version in **`package.json` only**. It is the single source of truth:
`build.mjs` injects it into each manifest at build time (so the `"version"` field in
`manifest.chrome.json` / `manifest.firefox.json` is just a placeholder the build
overwrites) and uses it to name the zips.

Then run `npm run package` to rebuild and zip. This produces all three submission zips
in `dist/`:

- `drtv-in-english-chrome-<version>.zip`
- `drtv-in-english-firefox-<version>.zip`
- `drtv-in-english-source-<version>.zip` — raw source for Firefox AMO review (Mozilla
  requires it for bundled add-ons). Generated from the `SOURCE_ENTRIES` list in
  `build.mjs`; contains only raw source, never `dist/` output, so it satisfies AMO's
  no-machine-generated-source rule.

Copy all three into `package/zips/` (removing the previous version's zips).

After packaging, update **`CHANGELOG.md`** with the new version number and release date.
Commit all changes together before submitting to stores.

## Things to look out for

- **Lessons from prior iterations** (in git history):
    - single-attach path for the English menu
    - don't re-force user state on SPA navigation
    - autoplay must stay inside the user gesture
    - CRLF in VTT collapses to one cue if not normalised

  Re-deriving these costs hours.
- **DRM playback is fine.** Phase 0 confirmed native `TextTrack` works on Widevine
  episodes; no overlay renderer is shipped.
- **MV3 service worker lifetime.** Chrome terminates idle workers (~30s). Translation
  work is chunked into short batches; a port from the content script keeps the worker
  alive while a job runs.
- **API key never leaves the user's machine** except to their configured LLM endpoint.
  Don't add telemetry or remote endpoints without an explicit decision in the plan doc.

## What's no longer in this repo

The pre-extension stack (FastAPI backend, Vue 3 + hls.js frontend, yt-dlp resolver, HLS
proxy, Docker Compose, nginx, pytest suite, Python package, makefile) was removed when
we pivoted to the extension. Git history before that commit still has it.
