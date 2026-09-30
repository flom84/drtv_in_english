// Gate playback on translation progress.
//
// Source of truth: the schedule of source cue start times (sent by the
// background once the Danish VTT has been parsed). Each batch of
// translated cues marks its source cues "ready". On each check we
// compute the frontier *dynamically* — the smallest un-ready cue at or
// ahead of the current playhead. That way a seek forward doesn't make
// us wait on stale cues from earlier in the episode.
//
// Pauses we initiate are tagged so manual user pauses aren't fought:
// if the user pauses while we're buffered, we don't auto-resume when
// the frontier moves; if the user resumes during a buffer, we'll
// re-pause on the next timeupdate.

// Pause when the next un-ready cue is within this much of the playhead.
const LOOKAHEAD_S = 0.5;

// Hysteresis: once we've paused, don't resume until at least this much
// translated runway is available ahead. Grows exponentially each time
// we re-enter buffer state shortly after resuming — so a slow run
// settles into a few long pauses rather than constant stutter.
const RUNWAY_BASE_S = 2;
const RUNWAY_MAX_S = 30;
// If we manage to play for this long after resuming, the streak resets.
const RUNWAY_STREAK_RESET_MS = 15_000;

export class BufferGuard {
  private video: HTMLVideoElement;
  private onStatus: (msg: string | null) => void;
  private starts: number[] = [];
  private startIndices = new Map<number, number[]>();
  private ready: boolean[] = [];
  private active = false;
  private autoPaused = false;
  private userPaused = false;
  private requiredRunwayS = RUNWAY_BASE_S;
  private lastResumeAt = 0;

  constructor(
    video: HTMLVideoElement,
    onStatus: (msg: string | null) => void,
  ) {
    this.video = video;
    this.onStatus = onStatus;
    video.addEventListener("timeupdate", this.check);
    video.addEventListener("seeking", this.check);
    video.addEventListener("pause", this.onPause);
    video.addEventListener("play", this.onPlay);
  }

  setSchedule(starts: number[]): void {
    this.starts = starts;
    this.startIndices.clear();
    for (let i = 0; i < starts.length; i++) {
      const key = Math.round(starts[i]! * 1000);
      const indices = this.startIndices.get(key);
      if (indices) indices.push(i);
      else this.startIndices.set(key, [i]);
    }
    this.ready = new Array(starts.length).fill(false);
    this.check();
  }

  // Gate playback immediately, before any schedule arrives. Called when
  // the user picks English so the video pauses right away instead of
  // playing on for the second-or-two it takes the background to fetch
  // and parse the Danish VTT.
  beginGate(): void {
    this.active = true;
    this.userPaused = false;
    this.autoPaused = true;
    this.requiredRunwayS = RUNWAY_BASE_S;
    if (!this.video.paused) this.video.pause();
    this.onStatus("Preparing English subtitles…");
  }

  markReady(cueStarts: number[]): void {
    for (const t of cueStarts) {
      const key = Math.round(t * 1000);
      for (let offset = -1; offset <= 1; offset++) {
        for (const idx of this.startIndices.get(key + offset) ?? []) {
          if (Math.abs(this.starts[idx]! - t) < 0.001) {
            this.ready[idx] = true;
          }
        }
      }
    }
    this.check();
  }

  reset(): void {
    this.starts = [];
    this.startIndices.clear();
    this.ready = [];
    if (this.autoPaused) this.resume();
    this.onStatus(null);
  }

  enable(): void {
    this.active = true;
    this.check();
  }

  disable(): void {
    this.active = false;
    if (this.autoPaused) this.resume();
    this.onStatus(null);
  }

  // Stop the guard without clearing the overlay — used when the
  // translation is done and we want the "English subtitles ready"
  // message to persist without check() overwriting it.
  stop(): void {
    this.active = false;
    this.video.removeEventListener("timeupdate", this.check);
    this.video.removeEventListener("seeking", this.check);
  }

  destroy(): void {
    this.video.removeEventListener("timeupdate", this.check);
    this.video.removeEventListener("seeking", this.check);
    this.video.removeEventListener("pause", this.onPause);
    this.video.removeEventListener("play", this.onPlay);
  }

  private check = (): void => {
    if (!this.active) return;
    if (this.starts.length === 0) {
      // No schedule yet but we may already be gating (beginGate). Keep
      // the overlay alive so it doesn't blank out between user-pick and
      // the first schedule event.
      if (this.autoPaused) {
        if (!this.video.paused) this.video.pause();
        this.onStatus(this.bufferLabel(0));
      }
      return;
    }
    const t = this.video.currentTime;
    // First un-ready cue at or ahead of the playhead. Cues behind the
    // playhead aren't needed right now — if the user scrolls back to
    // them, they'll be ready (or near-ready) thanks to background
    // re-prioritization.
    const frontier = this.frontierAhead(t);
    if (frontier === -1) {
      if (this.autoPaused) this.resume();
      this.onStatus(null);
      return;
    }
    const frontierTime = this.starts[frontier]!;
    const gap = frontierTime - t;
    // Is the very next cue the viewer will encounter already translated?
    // If not, the gap to the frontier is just untranslated dead air, not
    // runway — we mustn't let it count toward resuming.
    const nextIdx = this.firstAhead(t);
    const nextReady = nextIdx >= 0 && this.ready[nextIdx]!;

    if (this.autoPaused) {
      // Hysteresis: only resume once we have an actually-translated
      // runway — the next cue must be ready and we need at least
      // requiredRunwayS before hitting an un-ready wall.
      if (nextReady && gap >= this.requiredRunwayS) {
        this.resume();
        this.onStatus(null);
      } else {
        this.onStatus(this.bufferLabel(gap));
      }
      return;
    }

    if (!nextReady || gap < LOOKAHEAD_S) {
      // Entering buffer state. If we re-entered shortly after the
      // last resume, ramp the runway requirement up.
      if (
        this.lastResumeAt > 0 &&
        Date.now() - this.lastResumeAt < RUNWAY_STREAK_RESET_MS
      ) {
        this.requiredRunwayS = Math.min(
          RUNWAY_MAX_S,
          this.requiredRunwayS * 2,
        );
      } else {
        this.requiredRunwayS = RUNWAY_BASE_S;
      }
      this.onStatus(this.bufferLabel(gap));
      if (!this.video.paused) {
        this.autoPaused = true;
        this.video.pause();
      }
    } else {
      this.onStatus(null);
    }
  };

  private bufferLabel(_gap: number): string {
    return "Buffering English subtitles…";
  }

  private frontierAhead(t: number): number {
    // Linear scan is fine — schedules are O(few hundred) cues.
    for (let i = 0; i < this.starts.length; i++) {
      if (this.starts[i]! < t - 0.25) continue;
      if (!this.ready[i]) return i;
    }
    return -1;
  }

  private firstAhead(t: number): number {
    for (let i = 0; i < this.starts.length; i++) {
      if (this.starts[i]! >= t - 0.25) return i;
    }
    return -1;
  }

  private resume(): void {
    this.autoPaused = false;
    this.lastResumeAt = Date.now();
    if (this.userPaused) return;
    void this.video.play().catch(() => {
      // Playback can refuse if not in a user-gesture window — that's
      // acceptable; the user can hit play themselves.
    });
  }

  private onPause = (): void => {
    if (!this.autoPaused) this.userPaused = true;
  };

  private onPlay = (): void => {
    this.userPaused = false;
    // If the user clicked play while we're still gating (no runway yet),
    // immediately re-pause and re-assert the overlay. Without this they
    // can resume mid-translation and the player tries to play untranslated
    // territory.
    if (this.active && this.autoPaused) {
      // Defer so the play event finishes propagating before we pause.
      setTimeout(() => {
        if (this.autoPaused && !this.video.paused) {
          this.video.pause();
          this.onStatus(this.bufferLabel(0));
        }
      }, 0);
    }
  };
}
