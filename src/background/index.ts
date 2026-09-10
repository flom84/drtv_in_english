// Service worker entry. Owns the VTT sniffer, fetches the captured
// Danish VTT on demand, parses it, and streams stub-translated cues
// back to the content script through the connect-port.

import { PORT_NAME, type PortEvent, type PortMessage } from "../shared/types.js";
import {
  chooseBestPlaylist,
  clearVttForTab,
  deriveMasterUrl,
  getSubsForTab,
  installVttSniffer,
  setVttUrlForTab,
} from "./vtt-sniffer.js";
import { fetchCuesFromPlaylist, pageFetch } from "./playlist.js";
import {
  parseSubtitleTracks,
  pickDanishTrack,
} from "./master-manifest.js";
import { translateWithLLM } from "./translate-llm.js";
import { loadProviderConfig } from "../shared/storage.js";
import { getCachedCues, putCachedCues, sha256Hex } from "./cache.js";

installVttSniffer();

chrome.action?.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

// VTT URLs surfaced by the page-world sniffer injected from
// content/early.ts. This is the primary source — webRequest is a
// best-effort fallback.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type?: string; url?: string };
  const tabId = sender.tab?.id;
  if (m.type === "vtt-url" && m.url && tabId !== undefined) {
    setVttUrlForTab(tabId, m.url);
    console.log("[drtv-en/bg] captured VTT (page)", tabId, m.url);
  }
});

interface ActiveJob {
  episodeId: string;
  abort: AbortController;
  playhead: number;
}
const activeJobs = new Map<number, ActiveJob>();
// Heartbeat interval — cleared when job ends or port disconnects.
let heartbeatInterval: ReturnType<typeof setInterval> | undefined = undefined;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    console.warn("[drtv-en/bg] rejecting port connect without tab id", port.name);
    port.disconnect();
    return;
  }

  console.log("[drtv-en/bg] port connected for tab", tabId, "episode", port.sender?.url ?? "unknown");

  const send = (event: PortEvent) => {
    try {
      port.postMessage(event);
    } catch {
      // Port may already be torn down; nothing useful to do.
    }
  };

  port.onMessage.addListener((msg: PortMessage) => {
    console.log("[drtv-en/bg] port message", tabId, msg.type, msg);
    if (msg.type === "episode-active") {
      // Re-arm: a fresh episode means any pending job for this tab is
      // stale.
      cancelJob(tabId);
      return;
    }
    if (msg.type === "cancel") {
      cancelJob(tabId);
      return;
    }
    if (msg.type === "request-translate") {
      console.log("[drtv-en/bg] request-translate start", {
        tabId,
        episodeId: msg.episodeId,
        playhead: msg.playhead ?? 0,
      });
      void runJob(tabId, msg.episodeId, msg.playhead ?? 0, send);
    }
    if (msg.type === "seek") {
      const job = activeJobs.get(tabId);
      if (job) {
        console.log("[drtv-en/bg] seek update", { tabId, time: msg.time, old: job.playhead });
        job.playhead = msg.time;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    console.log("[drtv-en/bg] port disconnected for tab", tabId);
    clearInterval(heartbeatInterval);
    cancelJob(tabId);
  });
});

function cancelJob(tabId: number): void {
  const job = activeJobs.get(tabId);
  if (!job) return;
  job.abort.abort();
  activeJobs.delete(tabId);
}

async function runJob(
  tabId: number,
  episodeId: string,
  initialPlayhead: number,
  send: (e: PortEvent) => void,
): Promise<void> {
  cancelJob(tabId);
  const abort = new AbortController();
  const job: ActiveJob = { episodeId, abort, playhead: initialPlayhead };
  activeJobs.set(tabId, job);

  // Heartbeat to keep the service worker alive during long translations.
  // Chrome kills idle service workers after ~30s; vLLM endpoints can be
  // slow enough that translation exceeds this limit. Ping the content
  // script every 10s to keep the port connection alive.
  heartbeatInterval = setInterval(() => {
    try {
      send({ type: "heartbeat" });
    } catch {
      // Port may be gone; nothing useful to do.
    }
  }, 10_000);

  try {
    console.log("[drtv-en/bg] runJob start", { tabId, episodeId, initialPlayhead });
    const playlist = await waitForDanishPlaylist(tabId, abort.signal, send);
    if (!playlist) return;

    console.log("[drtv-en/bg] job", episodeId, "via playlist", playlist);
    send({ type: "status", state: "fetching-vtt", detail: playlist });
    const cues = await fetchCuesFromPlaylist(playlist, abort.signal);

    console.log("[drtv-en/bg] parsed cues:", cues.length, "first:", cues[0]);
    send({ type: "status", state: "parsing" });
    if (cues.length === 0) {
      console.warn("[drtv-en/bg] no cues parsed from playlist", playlist);
      send({ type: "error", message: "VTT parsed but no cues found" });
      return;
    }
    // Send the full schedule so the content script can gate playback
    // on translation progress. Must arrive before the first batch of
    // translated cues.
    send({ type: "schedule", starts: cues.map((c) => c.start) });

    const cfg = await loadProviderConfig();
    console.log("[drtv-en/bg] provider config loaded", {
      provider: cfg.provider,
      endpoint: cfg.endpoint,
      model: cfg.model,
      hasApiKey: !!cfg.apiKey,
      batchSize: cfg.batchSize,
      contextWindow: cfg.contextWindow,
      maxParallel: cfg.maxParallel,
    });
    if (
      (cfg.provider !== "libretranslate" && !cfg.apiKey) ||
      !cfg.endpoint ||
      !cfg.model
    ) {
      console.warn("[drtv-en/bg] missing provider config", cfg);
      send({
        type: "error",
        message:
          "Configure a provider and API key in the extension options first.",
      });
      return;
    }

    // Cache lookup — re-watching the same episode with the same
    // provider/model skips the LLM entirely. Hash includes timings so
    // any subtitle re-issue from DR invalidates the entry.
    const sourceHash = await sha256Hex(
      cues.map((c) => `${c.start}|${c.end}|${c.text}`).join("\n"),
    );
    const cached = await getCachedCues(
      episodeId,
      sourceHash,
      cfg.provider,
      cfg.model,
    ).catch((err) => {
      console.warn("[drtv-en/bg] cache lookup failed", err);
      return null;
    });
    console.log("[drtv-en/bg] source hash", { episodeId, sourceHash, cueCount: cues.length });
    if (cached) {
      console.log("[drtv-en/bg] cache hit:", cached.length, "cues");
      send({ type: "cues", cues: cached });
      send({ type: "done", total: cached.length });
      return;
    }
    console.log("[drtv-en/bg] cache miss for episode", episodeId);

    send({ type: "status", state: "translating", detail: String(cues.length) });
    const translated: typeof cues = [];
    const onBatch = (batch: typeof cues) => {
      translated.push(...batch);
      send({ type: "cues", cues: batch });
    };
    const total = await translateWithLLM(cues, cfg, {
      onBatch,
      signal: abort.signal,
      getPlayhead: () => job.playhead,
    });
    console.log("[drtv-en/bg] translateWithLLM finished", {
      episodeId,
      total,
      translatedCount: translated.length,
      aborted: abort.signal.aborted,
    });
    if (!abort.signal.aborted && translated.length > 0) {
      translated.sort((a, b) => a.start - b.start);
      void putCachedCues(
        episodeId,
        sourceHash,
        cfg.provider,
        cfg.model,
        translated,
      ).catch((err) => console.warn("[drtv-en/bg] cache save failed", err));
    }
    send({ type: "done", total });
  } catch (err) {
    if (abort.signal.aborted) return;
    send({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearInterval(heartbeatInterval);
    if (activeJobs.get(tabId)?.abort === abort) {
      activeJobs.delete(tabId);
    }
  }
}

// Wait up to ~10s for the sniffer to see the Danish VTT. If the user
// hasn't loaded subs yet, DR won't fetch them — we surface a hint via
// status so the content script can guide the user.
async function waitForDanishPlaylist(
  tabId: number,
  signal: AbortSignal,
  send: (e: PortEvent) => void,
): Promise<string | undefined> {
  // Resolve via the master manifest: it lists both Danish subtitle
  // tracks with proper metadata, so we can pick "Dansk" deterministically
  // without depending on DR's player to load it for us. This means
  // English mode works even on first click, with subs disabled in DR.
  //
  // Wait for *any* sniffed DRTV URL we can derive the master from —
  // typically arrives within a second of the page loading.
  send({ type: "status", state: "waiting-for-vtt" });
  const deadline = Date.now() + 10_000;
  while (!signal.aborted && Date.now() < deadline) {
    const subs = getSubsForTab(tabId);
    const masterUrl = subs ? deriveMasterUrl(subs) : undefined;
    console.log("[drtv-en/bg] waiting for Danish playlist", {
      tabId,
      observed: subs ? { masterUrl: subs.masterUrl, playlists: [...subs.playlists], segments: subs.segments.size } : null,
      masterUrl,
    });
    if (masterUrl) {
      const resolved = await tryResolveFromMaster(masterUrl, signal);
      if (resolved) return resolved;
      // Master fetch/parse failed: fall back to whatever playlist we
      // sniffed and try our string-heuristic pick.
      const heuristic = subs ? chooseBestPlaylist(subs) : undefined;
      if (heuristic) {
        console.warn(
          "[drtv-en/bg] master parse failed, using heuristic playlist",
          heuristic,
        );
        return heuristic;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (signal.aborted) return undefined;
  console.warn("[drtv-en/bg] waitForDanishPlaylist timed out", { tabId, deadlineMs: 10_000 });
  send({
    type: "error",
    message:
      "Could not find a Danish subtitle track for this episode (no DRTV URLs sniffed).",
  });
  return undefined;
}

async function tryResolveFromMaster(
  masterUrl: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    // Fetch via the page context (not a raw SW fetch): DR's subtitle
    // CDN isn't in host_permissions, so a service-worker fetch is
    // blocked by CORS in Chrome. The content script shares the dr.dk
    // origin and pulls it without trouble — same path as the playlist
    // and segment fetches.
    const text = await pageFetch(masterUrl);
    const tracks = parseSubtitleTracks(text);
    const danish = pickDanishTrack(tracks);
    if (!danish || !danish.uri) {
      console.warn("[drtv-en/bg] no Danish track in master", tracks);
      return undefined;
    }
    const playlist = new URL(danish.uri, masterUrl).toString();
    console.log("[drtv-en/bg] resolved Danish track via master:", playlist);
    return playlist;
  } catch (err) {
    if (signal.aborted) return undefined;
    console.warn("[drtv-en/bg] master resolution failed", err);
    return undefined;
  }
}

chrome.webNavigation?.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    clearVttForTab(details.tabId);
    cancelJob(details.tabId);
  },
  { url: [{ hostEquals: "www.dr.dk" }] },
);
