// Content script entry. The heavy lifting (VTT fetch, parse, translate,
// cache) runs in the background service worker; this file:
//   1. waits for DR's <video>,
//   2. mounts the 3-way menu on DR's subtitle button,
//   3. forwards English picks to the background as a translate request,
//   4. drops streamed cues onto a TextTrack,
//   5. follows DRTV's SPA navigation so each episode gets a fresh
//      pipeline without a full page reload.

import { extractEpisodeId } from "../shared/messaging.js";
import {
  PORT_NAME,
  type PortEvent,
  type PortMessage,
  type SubMode,
} from "../shared/types.js";
import { attachMenu, type MenuController } from "./menu.js";
import { TrackManager } from "./track-injector.js";
import { BufferGuard } from "./buffer-guard.js";

const TAG = "[drtv-en/content]";

interface EpisodeState {
  episodeId: string;
  video: HTMLVideoElement;
  track: TrackManager;
  menu: MenuController;
  guard: BufferGuard;
  port: chrome.runtime.Port;
  // DR's subtitle button is a toggle. We remember what we last drove
  // it to so picking Dansk vs Off doesn't double-click and undo itself.
  drSubsOn: boolean;
  destroyed: boolean;
  stallTimer: ReturnType<typeof setInterval> | null;
  lastProgressAt: number;
}

// If we reach this long without seeing the FIRST batch of cues, surface a
// retry hint. Mid-stream slowness is handled by the BufferGuard's own
// "Buffering English subtitles…" overlay — by then the user can see things
// are working, so we don't want to nag them with a "retry" message just
// because one batch took a while.
const STALL_HINT_MS = 60_000;

let state: EpisodeState | null = null;
let statusEl: HTMLElement | null = null;
let statusTextEl: HTMLElement | null = null;

async function bootEpisode(episodeId: string): Promise<void> {
  console.log(TAG, "bootEpisode start", { episodeId, href: location.href });
  const video = await waitForVideo();
  if (!video) {
    console.warn(TAG, "no <video> appeared in time");
    return;
  }
  console.log(TAG, "video found for episode", { episodeId, tagName: video.tagName, readyState: video.readyState });
  // Bail if we got torn down while waiting (user nav'd away mid-mount).
  if (state && state.episodeId !== episodeId) return;

  const track = new TrackManager(video);
  track.ensureTrack();
  const guard = new BufferGuard(video, (msg) => {
    if (msg) showStatus(msg, { busy: true });
    else hideStatus();
  });
  attachStatusOverlay(video);

  let lastSent = -1;
  const onSeek = () => {
    const t = Math.floor(video.currentTime);
    if (t === lastSent) return;
    lastSent = t;
    sendForState(s, { type: "seek", time: video.currentTime });
  };
  video.addEventListener("seeking", onSeek);

  const port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener(onPortEvent);

  const s: EpisodeState = {
    episodeId,
    video,
    track,
    menu: null as unknown as MenuController, // attached just below
    guard,
    port,
    drSubsOn: false,
    destroyed: false,
    stallTimer: null,
    lastProgressAt: 0,
  };
  state = s;

  port.onDisconnect.addListener(() => {
    console.log(TAG, "port disconnected");
    if (state === s) {
      // Background went away — don't keep a dead port reference.
      s.port = null as unknown as chrome.runtime.Port;
    }
  });
  sendForState(s, {
    type: "episode-active",
    episodeId,
    url: location.href,
  });

  s.menu = await attachMenu({
    initialTopPosition: false,
    onPick: (mode) => {
      if (state === s && !s.destroyed) applySelection(s, mode);
    },
    onTogglePosition: (top) => {
      if (state !== s || s.destroyed) return;
      s.track.setTopPosition(top);
      s.menu.setTopPosition(top);
    },
  });
  if (s.destroyed) return;
  console.log(TAG, "ready for episode", episodeId);
}

function teardownEpisode(reason: string): void {
  if (!state) return;
  const s = state;
  s.destroyed = true;
  console.log(TAG, "teardown:", reason, s.episodeId);
  try {
    s.port?.disconnect();
  } catch {
    /* port may already be gone */
  }
  s.guard.destroy();
  s.track.clear();
  s.menu.destroy();
  stopStallWatchdog(s);
  hideStatus();
  state = null;
}

function startStallWatchdog(s: EpisodeState): void {
  stopStallWatchdog(s);
  s.lastProgressAt = Date.now();
  s.stallTimer = setInterval(() => {
    if (s.destroyed) return;
    if (Date.now() - s.lastProgressAt < STALL_HINT_MS) return;
    showStatus(
      "Still translating — provider seems slow. Pick Off and English again to retry.",
      { busy: true },
    );
  }, 5000);
}

function stopStallWatchdog(s: EpisodeState): void {
  if (s.stallTimer !== null) {
    clearInterval(s.stallTimer);
    s.stallTimer = null;
  }
}

function bumpStallWatchdog(s: EpisodeState): void {
  s.lastProgressAt = Date.now();
}

function applySelection(s: EpisodeState, mode: SubMode): void {
  console.log(TAG, "selection:", mode);
  s.track.applyMode(mode);
  s.menu.setSelection(mode);

  // Only Dansk needs DR's player to render its native subs; English
  // and Off both want DR's overlay off (English shows ours instead,
  // Off shows nothing).
  const wantDrOn = mode === "dansk";
  if (wantDrOn !== s.drSubsOn) {
    if (s.menu.dispatchDrClick()) s.drSubsOn = wantDrOn;
  }

  if (mode === "english") {
    if (!hasEnglishCues(s.track)) {
      console.log(TAG, "requesting translation for English mode", {
        episodeId: s.episodeId,
        playhead: s.video.currentTime,
      });
      s.guard.reset();
      // Pause immediately so the user doesn't watch untranslated playback
      // while the background fetches / parses / starts translating.
      s.guard.beginGate();
      startStallWatchdog(s);
      sendForState(s, {
        type: "request-translate",
        episodeId: s.episodeId,
        playhead: s.video.currentTime,
      });
    } else {
      console.log(TAG, "English cues already present; re-enabling guard");
      s.guard.enable();
    }
  } else {
    s.guard.disable();
    sendForState(s, { type: "cancel" });
    stopStallWatchdog(s);
    hideStatus();
  }
}

function hasEnglishCues(t: TrackManager): boolean {
  return (t.ensureTrack().cues?.length ?? 0) > 0;
}

function sendForState(s: EpisodeState, msg: PortMessage): void {
  try {
    s.port?.postMessage(msg);
  } catch (err) {
    console.warn(TAG, "port send failed", err);
  }
}

function onPortEvent(event: PortEvent): void {
  const s = state;
  if (!s) {
    console.warn(TAG, "port event dropped — no state", event.type);
    return;
  }
  console.log(TAG, "port event:", event.type);
  switch (event.type) {
    case "status":
      // Pre-translation phases (fetching/parsing/etc) keep the centered
      // spinner visible. Once cues actually start streaming, the
      // BufferGuard takes over the overlay — see "cues" below.
      bumpStallWatchdog(s);
      showStatus(formatStatus(event.state), { busy: true });
      break;
    case "schedule":
      bumpStallWatchdog(s);
      s.guard.setSchedule(event.starts);
      break;
    case "cues":
      // First batch arrived: hand the overlay off to BufferGuard and
      // stop the pre-cue stall watchdog. Slow batches from here on are
      // visible to the user (subs are appearing) and the guard pauses
      // playback when runway runs out — no need for a "retry" nag.
      stopStallWatchdog(s);
      s.track.addCues(event.cues);
      s.guard.markReady(event.cues.map((cue) => cue.start));
      break;
    case "done":
      stopStallWatchdog(s);
      s.guard.stop();
      showStatus("English subtitles ready", { hideAfterMs: 2500 });
      break;
    case "error":
      stopStallWatchdog(s);
      s.guard.disable();
      showStatus(event.message, { hideAfterMs: 8000 });
      break;
    case "heartbeat":
      // Background keeps us alive — no action needed.
      break;
  }
}

function formatStatus(state: string): string {
  switch (state) {
    case "waiting-for-vtt":
      return "Waiting for DRTV subtitles…";
    case "fetching-vtt":
      return "Fetching Danish subtitles…";
    case "parsing":
      return "Reading subtitles…";
    case "translating":
      return "Translating subtitles to English…";
    default:
      return state;
  }
}

interface StatusOpts {
  busy?: boolean;
  hideAfterMs?: number;
}

function attachStatusOverlay(hostTarget: HTMLElement | HTMLVideoElement): void {
  const video = hostTarget instanceof HTMLVideoElement ? hostTarget : null;
  // Re-host the overlay if DR rebuilt the player container under us.
  if (statusEl && statusEl.isConnected && statusEl.parentElement) {
    if (video && statusEl.parentElement.contains(video)) return;
    console.log(TAG, "re-hosting overlay — video moved");
    statusEl.remove();
    statusEl = null;
    statusTextEl = null;
  }
  const host = video?.parentElement ?? hostTarget ?? document.body;
  console.log(TAG, "attachStatusOverlay host:", host.tagName, "video parent:", video?.parentElement?.tagName ?? "none");
  if (getComputedStyle(host).position === "static") {
    host.style.position = "relative";
  }
  statusEl = document.createElement("div");
  statusEl.className = "drtv-en-status";
  statusEl.style.display = "none";
  const spinner = document.createElement("div");
  spinner.className = "drtv-en-spinner";
  statusTextEl = document.createElement("span");
  statusEl.append(spinner, statusTextEl);
  host.appendChild(statusEl);
  console.log(TAG, "statusEl created, isConnected:", statusEl.isConnected);
}

function showStatus(text: string, opts: StatusOpts = {}): void {
  if (!statusEl || !statusTextEl) {
    console.warn(TAG, "showStatus called but statusEl is null");
    return;
  }
  console.log(TAG, "showStatus:", text, "busy:", !!opts.busy);
  statusTextEl.textContent = text;
  statusEl.classList.toggle("drtv-en-busy", !!opts.busy);
  statusEl.style.display = "flex";
  if (opts.hideAfterMs !== undefined) {
    setTimeout(() => hideStatus(), opts.hideAfterMs);
  }
}

function hideStatus(): void {
  console.log(TAG, "hideStatus called");
  if (statusEl) statusEl.style.display = "none";
}

function waitForVideo(timeoutMs = 30_000): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector("video");
    if (existing) return resolve(existing);
    const obs = new MutationObserver(() => {
      const v = document.querySelector("video");
      if (v) {
        obs.disconnect();
        resolve(v);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

// DRTV is a single-page app: clicking from one episode to another swaps
// the URL via pushState without a reload. We poll location.href (cheap)
// and tear down + re-init when the episode id changes. Background also
// listens for chrome.webNavigation.onHistoryStateUpdated to cancel its
// per-tab job.
function watchUrl(): void {
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const nextId = extractEpisodeId(location.href);
    const currentId = state?.episodeId ?? null;
    if (isLiveChannelPage(location.href)) {
      teardownEpisode("live-channel");
      showLivePageMessage();
      return;
    }
    if (nextId === currentId) return;
    teardownEpisode("spa-nav");
    if (nextId) void bootEpisode(nextId);
  }, 500);
}

function isLiveChannelPage(url: string): boolean {
  try {
    const u = new URL(url);
    return /\/drtv\/kanal\//i.test(u.pathname) || /\/drtv\/live\//i.test(u.pathname);
  } catch {
    return false;
  }
}

function showLivePageMessage(): void {
  const video = document.querySelector("video");
  const host = video?.parentElement ?? document.body;
  attachStatusOverlay(host);
  showStatus(
    "DRTV in English works on on-demand episodes only. Live TV pages are not supported yet.",
    { hideAfterMs: 8000 },
  );
}

function start(): void {
  if (isLiveChannelPage(location.href)) {
    console.warn(TAG, "ignoring live channel page", location.href);
    showLivePageMessage();
    return;
  }
  const id = extractEpisodeId(location.href);
  if (id) void bootEpisode(id);
  watchUrl();
}

start();
