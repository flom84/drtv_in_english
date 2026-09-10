// Resolve DR's subtitle HLS playlist into a merged cue list.
//
// Each segment is its own WebVTT document with overlapping cues at
// the boundaries; we dedupe by (start, text). Segments are fetched in
// parallel — they're tiny, and DR's CDN is fast.
//
// Fetch is done via the content script (not directly) to avoid CORS
// issues in Firefox MV3 service workers.

import { parseVtt } from "./vtt-parser.js";
import type { Cue } from "../shared/types.js";

export async function pageFetch(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) {
        reject(new Error("No active tab"));
        return;
      }
      chrome.tabs.sendMessage(
        tabId,
        { type: "fetch-url", url },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && typeof response === "object" && "error" in response) {
            reject(new Error(response.error as string));
            return;
          }
          if (typeof response === "string") {
            resolve(response);
          } else {
            reject(new Error("Invalid response from content script"));
          }
        },
      );
    });
  });
}

export async function fetchCuesFromPlaylist(
  playlistUrl: string,
  _signal: AbortSignal,
): Promise<Cue[]> {
  // Note: signal ignored — pageFetch doesn't support abort yet
  console.log("[drtv-en/bg] fetching playlist", playlistUrl);
  const text = await pageFetch(playlistUrl);
  const segmentUris = parseM3u8Segments(text);
  console.log("[drtv-en/bg] playlist segment count", { playlistUrl, count: segmentUris.length });
  if (segmentUris.length === 0) throw new Error("playlist had no segments");

  const base = new URL(playlistUrl);
  const segmentUrls = segmentUris.map((u) => new URL(u, base).toString());

  const results = await Promise.all(
    segmentUrls.map((u) => pageFetch(u)),
  );

  const merged: Cue[] = [];
  const seen = new Set<string>();
  for (const body of results) {
    for (const cue of parseVtt(body)) {
      const key = `${cue.start.toFixed(3)}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(cue);
    }
  }
  merged.sort((a, b) => a.start - b.start);
  return merged;
}

export async function fetchCuesFromSingleVtt(
  url: string,
  _signal: AbortSignal,
): Promise<Cue[]> {
  const text = await pageFetch(url);
  return parseVtt(text);
}

function parseM3u8Segments(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
