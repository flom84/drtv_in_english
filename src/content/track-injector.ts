// Manages one English TextTrack on the page's <video> element.
//
// Single-attach-path invariant (see docs/extension-plan.md §"Lessons"):
// the manager guards against double-creating the track when the menu
// is clicked repeatedly. ensureTrack() is the only entry point.

import type { Cue, SubMode } from "../shared/types.js";

const LABEL = "English (DRTV in English)";
const MARK = "data-drtv-en-track";

function cueKey(start: number, end: number, text: string): string {
  return `${start.toFixed(3)}|${end.toFixed(3)}|${text}`;
}

export class TrackManager {
  private video: HTMLVideoElement;
  private track: TextTrack | null = null;
  private existingCueKeys = new Set<string>();
  // When true, render cues near the top of the frame — used to dodge
  // burnt-in Danish subtitles on the accessibility ("tale-tekstning")
  // variants of some DR shows.
  private topPosition = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  // Vertical inset (percent of player height) from the nearest edge, so
  // our overlay sits in the same band DR uses for its own Danish subs
  // instead of flush against the frame edge.
  private static readonly EDGE_GAP_PCT = 12;

  setTopPosition(top: boolean): void {
    if (this.topPosition === top) return;
    this.topPosition = top;
    const cues = this.track?.cues;
    if (!cues) return;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (cue instanceof VTTCue) this.positionCue(cue);
    }
  }

  private positionCue(cue: VTTCue): void {
    cue.snapToLines = false;
    cue.line = this.topPosition
      ? TrackManager.EDGE_GAP_PCT
      : 100 - TrackManager.EDGE_GAP_PCT;
  }

  ensureTrack(): TextTrack {
    if (this.track) return this.track;
    for (const t of Array.from(this.video.textTracks)) {
      if (t.label === LABEL) {
        this.track = t;
        this.indexExistingCues(t);
        return t;
      }
    }
    const track = this.video.addTextTrack("subtitles", LABEL, "en");
    this.video.setAttribute(MARK, "1");
    this.track = track;
    this.indexExistingCues(track);
    return track;
  }

  private indexExistingCues(track: TextTrack): void {
    const cues = track.cues;
    if (!cues) return;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i] as VTTCue;
      this.existingCueKeys.add(cueKey(cue.startTime, cue.endTime, cue.text));
    }
  }

  addCues(cues: Cue[]): void {
    const track = this.ensureTrack();
    for (const c of cues) {
      const key = cueKey(c.start, c.end, c.text);
      if (this.existingCueKeys.has(key)) continue;
      try {
        const vtt = new VTTCue(c.start, c.end, c.text);
        this.positionCue(vtt);
        track.addCue(vtt);
        this.existingCueKeys.add(key);
      } catch (err) {
        console.warn("[drtv-en/content] addCue failed", err, c);
      }
    }
  }

  clear(): void {
    this.existingCueKeys.clear();
    if (!this.track) return;
    const cues = this.track.cues;
    if (!cues) return;
    for (let i = cues.length - 1; i >= 0; i--) {
      const cue = cues[i];
      if (cue) this.track.removeCue(cue);
    }
  }

  applyMode(mode: SubMode): void {
    // We only control our injected English track. DR's Danish subs are
    // rendered through their player's own DOM (confirmed in initial
    // Firefox testing: flipping `video.textTracks[i].mode` from outside
    // does nothing visible) — toggling those is left to DR's own
    // subtitle button, which the menu drives via a synthetic click.
    const track = this.ensureTrack();
    track.mode = mode === "english" ? "showing" : "hidden";
  }
}
