// Per-tab record of subtitle URLs the DR page has fetched. Populated
// from two sources:
//   1. Page-world fetch/XHR patch in content/early.ts (primary).
//   2. chrome.webRequest fallback (works when host permissions are
//      granted, which Firefox MV3 requires the user to opt into).
//
// DR ships TWO Danish subtitle playlists per episode:
//   - Foreign-…/playlist.m3u8           NAME="Fremmedsprogstekster"
//     Sparse — covers only non-Danish speech. DEFAULT=YES, so DR's
//     player loads it eagerly even when subs are off.
//   - Foreign_HardOfHearing-…/playlist.m3u8   NAME="Dansk"
//     The comprehensive Danish dialogue track. Loaded only when the
//     user enables subs in DR's player.
//
// We keep all observed playlists and pick the "Dansk" one at job time.

export interface TabSubs {
  masterUrl?: string;
  playlists: Set<string>;
  segments: Set<string>;
}

const byTab = new Map<number, TabSubs>();

function ensure(tabId: number): TabSubs {
  let s = byTab.get(tabId);
  if (!s) {
    s = { playlists: new Set(), segments: new Set() };
    byTab.set(tabId, s);
  }
  return s;
}

const SEGMENT_RE = /^(.*\/subtitles\/[^/]+\/)segment_\d+\.vtt(\?|#|$)/i;

export function setVttUrlForTab(tabId: number, url: string): void {
  const s = ensure(tabId);
  if (/\/master[^/]*\.m3u8/i.test(url)) {
    s.masterUrl = url;
    console.log("[drtv-en/bg] sniffed master manifest", { tabId, url });
    return;
  }
  if (/\/subtitles\/[^?#]*\.m3u8/i.test(url)) {
    s.playlists.add(url);
    console.log("[drtv-en/bg] sniffed playlist", { tabId, url });
    return;
  }
  s.segments.add(url);
  // Page-world patch may miss the m3u8 itself if the player kicked off
  // the request before our patch installed. Derive the playlist URL
  // from any segment we *did* see — DR's filenames are deterministic.
  const m = SEGMENT_RE.exec(url);
  if (m) s.playlists.add(`${m[1]}playlist.m3u8`);
}

// Derive the master manifest URL from any captured subtitle URL by
// walking up to the episode root. Used when the sniffer missed the
// master itself (it can race with our content-script injection at
// page load).
export function deriveMasterUrl(subs: TabSubs): string | undefined {
  if (subs.masterUrl) return subs.masterUrl;
  const sample =
    subs.playlists.values().next().value ??
    subs.segments.values().next().value;
  if (!sample) return undefined;
  const m = /^(.*)\/subtitles\//i.exec(sample);
  if (!m) return undefined;
  return `${m[1]}/stream_fmp4/master_manifest.m3u8`;
}

export function getSubsForTab(tabId: number): TabSubs | undefined {
  return byTab.get(tabId);
}

export function chooseBestPlaylist(subs: TabSubs): string | undefined {
  // The "Dansk" track URL contains "HardOfHearing" in DR's naming.
  for (const p of subs.playlists) {
    if (/HardOfHearing/i.test(p)) {
      console.log("[drtv-en/bg] chose Dansk playlist by HardOfHearing naming", p);
      return p;
    }
  }
  // Otherwise: any playlist that doesn't smell like a foreign-only
  // ("Fremmedsprog") track.
  for (const p of subs.playlists) {
    if (!/\/Foreign-/i.test(p)) {
      console.log("[drtv-en/bg] chose fallback playlist", p);
      return p;
    }
  }
  console.warn("[drtv-en/bg] no usable playlist found in tab subs", {
    playlists: [...subs.playlists],
    segments: subs.segments.size,
  });
  return undefined;
}

export function clearVttForTab(tabId: number): void {
  byTab.delete(tabId);
}

export function installVttSniffer(): void {
  // Best-effort webRequest fallback. Requires host permissions granted
  // by the user; if Firefox hasn't been told to enable them, this
  // listener simply never fires and the page-world sniffer carries
  // the load.
  //
  // Chrome's manifest doesn't grant `webRequest`, so `chrome.webRequest`
  // is undefined there. Touching it would throw at module load — before
  // onConnect is registered in index.ts — leaving the content script hung
  // on the buffering overlay.
  // Skip gracefully; the page-world sniffer (early.ts) is the primary
  // source on every browser.
  if (!chrome.webRequest?.onCompleted) {
    chrome.tabs?.onRemoved.addListener((tabId) => {
      byTab.delete(tabId);
    });
    return;
  }
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const url = details.url;
      const looksLikeVtt =
        /\.vtt(\?|#|$)/i.test(url) ||
        /\.webvtt(\?|#|$)/i.test(url) ||
        /\/subtitles\/[^?#]*\.m3u8/i.test(url) ||
        /\/master[^/]*\.m3u8/i.test(url);
      if (!looksLikeVtt) return;
      setVttUrlForTab(details.tabId, url);
      console.log("[drtv-en/bg] captured VTT (webRequest)", details.tabId, url);
    },
    { urls: ["<all_urls>"] },
  );

  chrome.tabs.onRemoved.addListener((tabId) => {
    byTab.delete(tabId);
  });
}
