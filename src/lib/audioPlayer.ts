type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/** Tiny silent WAV used to unlock HTMLAudioElement on iOS Safari. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

/** Look-ahead when scheduling on AudioContext timeline (seconds). */
const SCHEDULE_AHEAD_SEC = 0.025;

/** Short crossfade hides MP3 encoder padding / click at joins. */
const CROSSFADE_SEC = 0.02;

/** Near-zero pad once PCM duration is known (human-speech handoff). */
const TAIL_PAD_TRUSTED_MS = 8;

/** Small pad only when duration is a rough estimate (HTML fallback). */
const TAIL_PAD_ESTIMATE_MS = 60;

/** Never trust an `ended` that fires before this fraction of expected duration. */
const EARLY_END_RATIO = 0.88;

/** Amplitude threshold for trimming encoder silence at clip edges. */
const SILENCE_AMP = 0.012;

/** Keep at least this much audio after trim (seconds). */
const MIN_TRIMMED_SEC = 0.08;

export type DurationTrust = "decoded" | "api" | "estimate";

export type PreparedClip = {
  kind: "decoded";
  audioBuffer: AudioBuffer;
  raw: ArrayBuffer;
  durationSec: number;
  mimeType: string;
  trust: DurationTrust;
} | {
  kind: "raw";
  buffer: ArrayBuffer;
  durationSec?: number;
  mimeType: string;
  trust: DurationTrust;
};

export type PreparedAudio =
  | PreparedClip
  | {
      kind: "sequence";
      parts: PreparedClip[];
      durationSec: number;
    };

export type PrepareInput = {
  buffer: ArrayBuffer;
  durationSec?: number;
  mimeType?: string;
  /** True when durationSec came from TTS API / timestamps. */
  durationTrusted?: boolean;
};

export type PlayPreparedOptions = {
  /**
   * Silence after this clip/sequence before the play promise resolves.
   * Scheduled on the audio clock for Web Audio (true gapless handoff).
   */
  gapAfterMs?: number;
};

/** One paragraph (or multi-part clip) in a pre-scheduled background window. */
export type TimelineSegment = {
  prepared: PreparedAudio;
  gapAfterMs?: number;
};

export type PlayWindowOptions = {
  /** Fires when a segment becomes the audible head (UI highlight). */
  onSegmentStart?: (index: number) => void;
};

export type MediaSessionHandlers = {
  play?: () => void;
  pause?: () => void;
  nexttrack?: () => void;
  previoustrack?: () => void;
};

function getAudioContextConstructor(): typeof AudioContext | undefined {
  const Win = window as AudioWindow;
  return window.AudioContext || Win.webkitAudioContext;
}

/** Rough MP3 duration from byte length (assumes ~128 kbps CBR). */
function estimateMp3DurationSec(bytes: ArrayBuffer): number {
  if (!bytes || bytes.byteLength < 256) return 0;
  const sec128 = (bytes.byteLength * 8) / 128_000;
  const sec96 = (bytes.byteLength * 8) / 96_000;
  return Math.max(sec128, sec96 * 0.85);
}

/**
 * Playback duration for HTML path. Prefer real element/API duration —
 * never stretch with the MP3 byte estimate (that left long silent tails).
 */
function pickPlayDurationSec(
  knownDuration: number,
  elementDuration: number,
  byteEstimate: number,
): number {
  if (Number.isFinite(elementDuration) && elementDuration > 0) {
    return elementDuration;
  }
  if (Number.isFinite(knownDuration) && knownDuration > 0) {
    return knownDuration;
  }
  if (Number.isFinite(byteEstimate) && byteEstimate > 0) {
    return byteEstimate;
  }
  return 0;
}

/**
 * Strip leading/trailing encoder silence so paragraph joins sound like
 * continuous speech instead of "clip + dead air + clip".
 */
function trimSilence(
  ctx: AudioContext,
  input: AudioBuffer,
  threshold = SILENCE_AMP,
): AudioBuffer {
  const channels = input.numberOfChannels;
  const rate = input.sampleRate;
  const total = input.length;
  if (total < rate * MIN_TRIMMED_SEC) return input;

  const peaks = new Float32Array(total);
  for (let c = 0; c < channels; c++) {
    const data = input.getChannelData(c);
    for (let i = 0; i < total; i++) {
      const a = Math.abs(data[i]);
      if (a > peaks[i]) peaks[i] = a;
    }
  }

  let start = 0;
  while (start < total && peaks[start] < threshold) start += 1;

  let end = total - 1;
  while (end > start && peaks[end] < threshold) end -= 1;

  // Keep a few ms of tail so the last consonant isn't clipped
  const pad = Math.floor(rate * 0.012);
  start = Math.max(0, start - Math.floor(rate * 0.004));
  end = Math.min(total - 1, end + pad);

  const outLen = end - start + 1;
  if (outLen >= total - 8 || outLen < rate * MIN_TRIMMED_SEC) {
    return input;
  }

  const out = ctx.createBuffer(channels, outLen, rate);
  for (let c = 0; c < channels; c++) {
    out
      .getChannelData(c)
      .set(input.getChannelData(c).subarray(start, end + 1));
  }
  return out;
}

function flattenPrepared(prepared: PreparedAudio): PreparedClip[] {
  if (prepared.kind === "sequence") return prepared.parts;
  return [prepared];
}

function tailPadMs(trust: DurationTrust): number {
  return trust === "estimate" ? TAIL_PAD_ESTIMATE_MS : TAIL_PAD_TRUSTED_MS;
}

/**
 * Podcast-smooth player: Web Audio timeline scheduling for gapless joins,
 * adaptive tail pads, and dual HTMLAudio elements as mobile fallback.
 */
export class MobileAudioPlayer {
  private ctx: AudioContext | null = null;
  private elements: HTMLAudioElement[] = [];
  private activeEl = 0;
  private objectUrls: (string | null)[] = [null, null];
  private unlocked = false;
  private playToken = 0;
  /** Bumped by stop() so in-flight loops exit. */
  private generation = 0;
  private settleCurrent: ((reason: "ended" | "stopped" | "error") => void) | null =
    null;
  private visibilityHandler: (() => void) | null = null;
  /** AudioContext time when the current timeline is free for the next schedule. */
  private timelineEnd = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private masterGain: GainNode | null = null;
  /** Near-silent loop keeps the iOS audio session alive while JS is suspended. */
  private keepAliveSource: AudioBufferSourceNode | null = null;
  private segmentTimers: number[] = [];

  /** Call synchronously inside a click/touch handler. */
  unlock(): void {
    const AC = getAudioContextConstructor();
    if (AC) {
      if (!this.ctx || this.ctx.state === "closed") {
        this.ctx = new AC();
        this.masterGain = null;
        this.keepAliveSource = null;
      }
      void this.ctx.resume();
      this.ensureMasterGain();
      this.startKeepAlive();
    }

    this.ensureElements();
    const el = this.elements[0];
    el.src = SILENT_WAV;
    const playPromise = el.play();
    if (playPromise) {
      void playPromise
        .then(() => {
          el.pause();
          el.currentTime = 0;
        })
        .catch(() => {
          /* ignore */
        });
    }

    if (!this.visibilityHandler && typeof document !== "undefined") {
      this.visibilityHandler = () => {
        // Resume session both when returning AND when entering background
        // (iOS may suspend AudioContext on hide).
        if (this.ctx) void this.ctx.resume();
        this.startKeepAlive();
        const cur = this.elements[this.activeEl];
        if (
          document.visibilityState === "visible" &&
          cur &&
          cur.paused &&
          this.settleCurrent
        ) {
          void cur.play().catch(() => undefined);
        }
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
      document.addEventListener("pagehide", this.visibilityHandler);
      window.addEventListener("pageshow", this.visibilityHandler);
    }

    this.unlocked = true;
  }

  /** Inaudible looping buffer so iOS does not tear down the playback session. */
  private startKeepAlive(): void {
    if (!this.ctx || this.ctx.state === "closed") return;
    if (this.keepAliveSource) return;
    try {
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      // Non-zero: fully muted nodes can be culled by iOS power management.
      g.gain.value = 0.00001;
      src.connect(g);
      g.connect(this.ctx.destination);
      src.start();
      this.keepAliveSource = src;
    } catch {
      this.keepAliveSource = null;
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAliveSource) {
      try {
        this.keepAliveSource.stop();
      } catch {
        /* ignore */
      }
      try {
        this.keepAliveSource.disconnect();
      } catch {
        /* ignore */
      }
      this.keepAliveSource = null;
    }
  }

  private clearSegmentTimers(): void {
    for (const id of this.segmentTimers) {
      window.clearTimeout(id);
    }
    this.segmentTimers = [];
  }

  private ensureMasterGain(): GainNode | null {
    if (!this.ctx) return null;
    if (!this.masterGain) {
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;
      this.masterGain.connect(this.ctx.destination);
    }
    return this.masterGain;
  }

  private ensureElements(): void {
    while (this.elements.length < 2) {
      this.elements.push(this.createElement());
    }
  }

  private createElement(): HTMLAudioElement {
    const el = new Audio();
    el.setAttribute("playsinline", "true");
    el.setAttribute("webkit-playsinline", "true");
    el.preload = "auto";
    el.setAttribute("x-webkit-airplay", "allow");
    if (typeof document !== "undefined" && !el.isConnected) {
      el.style.display = "none";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    }
    return el;
  }

  private revokeUrl(index: number): void {
    const url = this.objectUrls[index];
    if (url) {
      URL.revokeObjectURL(url);
      this.objectUrls[index] = null;
    }
  }

  private revokeAllUrls(): void {
    this.revokeUrl(0);
    this.revokeUrl(1);
  }

  private finishPlayback(reason: "ended" | "stopped" | "error"): void {
    const settle = this.settleCurrent;
    this.settleCurrent = null;
    settle?.(reason);
  }

  private stopSources(): void {
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* ignore */
      }
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.activeSources = [];
  }

  async prepare(
    input: ArrayBuffer | PrepareInput | Array<PrepareInput | ArrayBuffer>,
  ): Promise<PreparedAudio> {
    if (Array.isArray(input)) {
      const parts: PreparedClip[] = [];
      for (const item of input) {
        const prepared = await this.prepare(item);
        if (prepared.kind === "sequence") {
          parts.push(...prepared.parts);
        } else {
          parts.push(prepared);
        }
      }
      const durationSec = parts.reduce(
        (sum, p) => sum + (p.durationSec || 0),
        0,
      );
      return { kind: "sequence", parts, durationSec };
    }

    const buffer = input instanceof ArrayBuffer ? input : input.buffer;
    const hintDuration =
      input instanceof ArrayBuffer ? undefined : input.durationSec;
    const durationTrusted =
      input instanceof ArrayBuffer ? false : Boolean(input.durationTrusted);
    const mimeType =
      (input instanceof ArrayBuffer ? undefined : input.mimeType) ||
      "audio/mpeg";
    const isWav = /wav|wave/i.test(mimeType);
    const byteEstimate = isWav ? 0 : estimateMp3DurationSec(buffer);
    const AC = getAudioContextConstructor();
    if (!AC) {
      const durationSec = Math.max(hintDuration || 0, byteEstimate) || undefined;
      return {
        kind: "raw",
        buffer,
        durationSec,
        mimeType,
        trust: durationTrusted && hintDuration ? "api" : "estimate",
      };
    }

    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AC();
      this.masterGain = null;
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => undefined);
    }

    try {
      const decoded = await this.ctx.decodeAudioData(buffer.slice(0));
      // Use PCM length only — byte-rate estimates were longer than real audio
      // and inserted dead air between every paragraph.
      const trimmed = trimSilence(this.ctx, decoded);
      const durationSec = trimmed.duration;
      return {
        kind: "decoded",
        audioBuffer: trimmed,
        raw: buffer,
        durationSec,
        mimeType,
        trust: "decoded" as DurationTrust,
      };
    } catch {
      return {
        kind: "raw",
        buffer,
        durationSec:
          (durationTrusted && hintDuration) || byteEstimate || undefined,
        mimeType,
        trust: durationTrusted && hintDuration ? "api" : "estimate",
      };
    }
  }

  async playPrepared(
    prepared: PreparedAudio,
    opts: PlayPreparedOptions = {},
  ): Promise<void> {
    await this.playWindow([{ prepared, gapAfterMs: opts.gapAfterMs }], {});
  }

  /**
   * Schedule several paragraphs onto the Web Audio clock at once.
   * Critical for iOS background: JS timers freeze, but already-scheduled
   * AudioBufferSourceNodes keep playing under UIBackgroundModes=audio.
   */
  async playWindow(
    segments: TimelineSegment[],
    opts: PlayWindowOptions = {},
  ): Promise<void> {
    if (!this.unlocked) {
      throw new Error(
        "请先点击「继续朗读」按钮开始播放（手机浏览器需要手动触发声音）",
      );
    }
    if (segments.length === 0) return;

    if (this.ctx?.state === "suspended") {
      await this.ctx.resume().catch(() => undefined);
    }
    this.startKeepAlive();

    const decodedWindows: {
      parts: Extract<PreparedClip, { kind: "decoded" }>[];
      gapAfterMs: number;
    }[] = [];
    let allDecoded = true;
    for (const seg of segments) {
      const parts = flattenPrepared(seg.prepared);
      if (
        parts.length === 0 ||
        !parts.every((p) => p.kind === "decoded") ||
        !this.ctx ||
        this.ctx.state === "closed"
      ) {
        allDecoded = false;
        break;
      }
      decodedWindows.push({
        parts: parts as Extract<PreparedClip, { kind: "decoded" }>[],
        gapAfterMs: Math.max(0, seg.gapAfterMs ?? 0),
      });
    }

    if (allDecoded && this.ctx?.state === "running") {
      const ok = await this.playDecodedWindow(decodedWindows, opts);
      if (ok) return;
    }

    // HTMLAudio fallback — sequential (still better than silence).
    const gen = this.generation;
    for (let s = 0; s < segments.length; s++) {
      if (this.generation !== gen) return;
      opts.onSegmentStart?.(s);
      const parts = flattenPrepared(segments[s].prepared);
      const gapAfterMs = Math.max(0, segments[s].gapAfterMs ?? 0);
      for (let i = 0; i < parts.length; i++) {
        if (this.generation !== gen) return;
        const part = parts[i];
        const isLast = i === parts.length - 1 && s === segments.length - 1;
        // gap only after full segment
        const partGap =
          i === parts.length - 1 ? (isLast ? gapAfterMs : gapAfterMs) : 0;
        const raw = part.kind === "decoded" ? part.raw : part.buffer;
        const token = ++this.playToken;
        await this.playHtmlWithGate(
          raw,
          part.durationSec ?? 0,
          part.mimeType || "audio/mpeg",
          part.trust,
          token,
          i === parts.length - 1 ? gapAfterMs : 0,
        );
      }
    }
  }

  /**
   * Schedule one or more paragraph windows on the AudioContext clock.
   * All buffers are queued up-front so playback survives iOS JS suspension.
   */
  private async playDecodedWindow(
    windows: {
      parts: Extract<PreparedClip, { kind: "decoded" }>[];
      gapAfterMs: number;
    }[],
    opts: PlayWindowOptions,
  ): Promise<boolean> {
    if (!this.ctx || this.ctx.state !== "running") return false;
    const gainMaster = this.ensureMasterGain();
    if (!gainMaster) return false;

    this.finishPlayback("stopped");
    this.clearSegmentTimers();
    const token = ++this.playToken;
    const gen = this.generation;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const chaining = this.timelineEnd > now + 0.001;
    if (!chaining) {
      this.stopSources();
    }
    let t = chaining ? this.timelineEnd : now + SCHEDULE_AHEAD_SEC;
    const fade = CROSSFADE_SEC;
    let scheduledCount = 0;
    const segmentStarts: number[] = [];

    try {
      for (let w = 0; w < windows.length; w++) {
        const { parts, gapAfterMs } = windows[w];
        let segmentStart = -1;
        for (let i = 0; i < parts.length; i++) {
          const audioBuffer = parts[i].audioBuffer;
          const dur = audioBuffer.duration;
          if (dur <= 0) continue;

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          const gain = ctx.createGain();
          source.connect(gain);
          gain.connect(gainMaster);

          const isJoin = scheduledCount > 0 || chaining;
          const overlap = isJoin ? fade : 0;
          const startAt = Math.max(t - overlap, now);
          if (segmentStart < 0) segmentStart = startAt;
          const fadeInEnd = startAt + Math.min(fade, dur * 0.2);
          const fadeOutStart = startAt + Math.max(dur - fade, dur * 0.55);

          gain.gain.setValueAtTime(overlap > 0 ? 0.0001 : 1, startAt);
          if (overlap > 0) {
            gain.gain.linearRampToValueAtTime(1, fadeInEnd);
          }
          if (dur > fade * 2) {
            gain.gain.setValueAtTime(1, fadeOutStart);
            gain.gain.linearRampToValueAtTime(0.0001, startAt + dur);
          }

          source.onended = () => {
            this.activeSources = this.activeSources.filter((s) => s !== source);
            try {
              source.disconnect();
            } catch {
              /* ignore */
            }
          };
          source.start(startAt);
          this.activeSources.push(source);
          scheduledCount += 1;
          t = startAt + dur;
        }

        if (segmentStart >= 0) {
          segmentStarts.push(segmentStart);
        }
        t += Math.max(0, gapAfterMs) / 1000;
      }
    } catch {
      this.stopSources();
      return false;
    }

    if (scheduledCount === 0) return false;

    this.timelineEnd = t;

    // UI highlight timers (best-effort; may lag if JS is frozen in background)
    if (opts.onSegmentStart) {
      for (let i = 0; i < segmentStarts.length; i++) {
        const delayMs = Math.max(
          0,
          (segmentStarts[i] - ctx.currentTime) * 1000,
        );
        const idx = i;
        if (delayMs < 16) {
          opts.onSegmentStart(idx);
        } else {
          const id = window.setTimeout(() => {
            if (this.generation !== gen || token !== this.playToken) return;
            opts.onSegmentStart?.(idx);
          }, delayMs);
          this.segmentTimers.push(id);
        }
      }
    }

    // Pull next batch slightly before this window ends (when JS is running).
    const waitUntil = Math.max(
      now + 0.01,
      this.timelineEnd - CROSSFADE_SEC - SCHEDULE_AHEAD_SEC,
    );

    const outcome = await new Promise<"ended" | "stopped" | "error">(
      (resolve) => {
        let finished = false;
        const done = (reason: "ended" | "stopped" | "error") => {
          if (finished) return;
          finished = true;
          window.clearInterval(gate);
          this.settleCurrent = null;
          resolve(reason);
        };
        this.settleCurrent = done;

        const gate = window.setInterval(() => {
          if (token !== this.playToken || this.generation !== gen) {
            done("stopped");
            return;
          }
          if (!this.ctx || this.ctx.state === "closed") {
            done("error");
            return;
          }
          if (this.ctx.state === "suspended") {
            void this.ctx.resume().catch(() => undefined);
            this.startKeepAlive();
          }
          if (this.ctx.currentTime >= waitUntil - 0.005) {
            done("ended");
          }
        }, 32);
      },
    );

    if (token !== this.playToken || outcome === "stopped") {
      return true;
    }
    if (outcome === "error") throw new Error("音频播放失败");
    return true;
  }

  private async playHtmlWithGate(
    buffer: ArrayBuffer,
    knownDuration: number,
    mimeType: string,
    trust: DurationTrust,
    token: number,
    gapAfterMs: number,
  ): Promise<void> {
    this.ensureElements();
    this.finishPlayback("stopped");

    this.activeEl = this.activeEl ^ 1;
    const el = this.elements[this.activeEl];
    const other = this.elements[this.activeEl ^ 1];
    if (other && !other.paused) {
      try {
        other.pause();
      } catch {
        /* ignore */
      }
    }

    el.pause();
    this.revokeUrl(this.activeEl);
    const blob = new Blob([buffer], { type: mimeType || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    this.objectUrls[this.activeEl] = url;
    el.src = url;
    el.load();

    const byteEstimate = /wav|wave/i.test(mimeType)
      ? 0
      : estimateMp3DurationSec(buffer);
    const startedAt = performance.now();
    const padMs = tailPadMs(trust);

    await new Promise<void>((resolve) => {
      if (el.readyState >= 2) {
        resolve();
        return;
      }
      const onReady = () => {
        el.removeEventListener("canplay", onReady);
        el.removeEventListener("loadedmetadata", onReady);
        resolve();
      };
      el.addEventListener("canplay", onReady);
      el.addEventListener("loadedmetadata", onReady);
      window.setTimeout(resolve, 800);
    });

    if (token !== this.playToken) return;

    const safeElementDuration = () => {
      const d = el.duration;
      return Number.isFinite(d) && d > 0 && d < 60 * 60 * 6 ? d : 0;
    };

    const outcome = await new Promise<"ended" | "stopped" | "error">(
      (resolve, reject) => {
        let finished = false;
        let endedSignal = false;
        let padTimer: number | null = null;

        const cleanup = () => {
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
          el.removeEventListener("timeupdate", onTimeUpdate);
          window.clearInterval(gate);
          if (padTimer != null) window.clearTimeout(padTimer);
        };

        const done = (reason: "ended" | "stopped" | "error") => {
          if (finished) return;
          finished = true;
          cleanup();
          this.settleCurrent = null;
          resolve(reason);
        };

        this.settleCurrent = done;

        const expectedMs = () => {
          const sec = pickPlayDurationSec(
            knownDuration,
            safeElementDuration(),
            byteEstimate,
          );
          return sec > 0 ? sec * 1000 : 0;
        };

        const finishSoon = () => {
          if (finished || token !== this.playToken) {
            if (token !== this.playToken) done("stopped");
            return;
          }
          if (padTimer == null) {
            padTimer = window.setTimeout(() => {
              padTimer = null;
              done("ended");
            }, padMs);
          }
        };

        const tryFinish = (fromEnded: boolean) => {
          if (finished || token !== this.playToken) {
            if (token !== this.playToken) done("stopped");
            return;
          }

          const need = expectedMs();
          const elapsed = performance.now() - startedAt;

          // Natural end event: do not wait out an inflated duration estimate.
          if (fromEnded) {
            if (need > 0 && elapsed < need * EARLY_END_RATIO) {
              if (el.paused && !el.ended) {
                void el.play().catch(() => undefined);
              }
              return;
            }
            finishSoon();
            return;
          }

          if (need > 0 && elapsed < need * EARLY_END_RATIO) {
            if (el.paused && !el.ended) {
              void el.play().catch(() => undefined);
            }
            return;
          }

          if (need > 0 && elapsed < need - 15) {
            if (padTimer == null) {
              padTimer = window.setTimeout(() => {
                padTimer = null;
                tryFinish(false);
              }, Math.max(15, need - elapsed));
            }
            return;
          }

          finishSoon();
        };

        const onEnded = () => {
          endedSignal = true;
          tryFinish(true);
        };

        const onTimeUpdate = () => {
          const dur = safeElementDuration();
          if (dur > 0 && el.currentTime >= dur - 0.04) {
            tryFinish(false);
          }
        };

        const onError = () => done("error");

        const gate = window.setInterval(() => {
          if (token !== this.playToken) {
            done("stopped");
            return;
          }
          if (finished) return;

          const need = expectedMs();
          const elapsed = performance.now() - startedAt;

          if (endedSignal) {
            tryFinish(true);
            return;
          }

          if (need > 0 && elapsed >= need + padMs) {
            if (
              el.ended ||
              el.paused ||
              (safeElementDuration() > 0 &&
                el.currentTime >= safeElementDuration() - 0.08)
            ) {
              done("ended");
              return;
            }
            if (elapsed >= need + 1200) {
              done("ended");
            }
          }
        }, 32);

        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onError);
        el.addEventListener("timeupdate", onTimeUpdate);

        void el.play().catch((err: unknown) => {
          if (token !== this.playToken) {
            done("stopped");
            return;
          }
          cleanup();
          this.settleCurrent = null;
          finished = true;
          reject(normalizePlayError(err));
        });
      },
    );

    if (token !== this.playToken || outcome === "stopped") return;
    if (outcome === "error") throw new Error("音频播放失败");

    if (gapAfterMs > 0 && token === this.playToken) {
      await new Promise<void>((r) => setTimeout(r, gapAfterMs));
    }
  }

  async playArrayBuffer(buffer: ArrayBuffer): Promise<void> {
    const prepared = await this.prepare(buffer);
    await this.playPrepared(prepared);
  }

  stop(): void {
    this.generation += 1;
    this.playToken += 1;
    this.timelineEnd = 0;
    this.finishPlayback("stopped");
    this.clearSegmentTimers();
    this.stopSources();
    this.stopKeepAlive();
    for (const el of this.elements) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        /* ignore */
      }
    }
    this.revokeAllUrls();
  }

  isPlaying(): boolean {
    const el = this.elements[this.activeEl];
    if (el && !el.paused && !el.ended) return true;
    return this.activeSources.length > 0;
  }
}

export function setMediaSession(
  meta: { title: string; artist?: string; album?: string },
  handlers: MediaSessionHandlers,
): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title,
      artist: meta.artist || "听页 ListenPage",
      album: meta.album || "EPUB 朗读",
    });
  } catch {
    /* MediaMetadata may be unavailable */
  }

  const bind = (
    action: MediaSessionAction,
    handler: (() => void) | undefined,
  ) => {
    try {
      if (handler) {
        navigator.mediaSession.setActionHandler(action, () => handler());
      } else {
        navigator.mediaSession.setActionHandler(action, null);
      }
    } catch {
      /* unsupported action on this browser */
    }
  };

  bind("play", handlers.play);
  bind("pause", handlers.pause);
  bind("nexttrack", handlers.nexttrack);
  bind("previoustrack", handlers.previoustrack);
}

export function setMediaSessionPlaybackState(
  state: "none" | "paused" | "playing",
): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    /* ignore */
  }
}

export function normalizePlayError(err: unknown): Error {
  if (err instanceof DOMException || err instanceof Error) {
    const msg = err.message || "";
    if (
      err.name === "NotAllowedError" ||
      /not allowed by the user agent|user denied permission/i.test(msg)
    ) {
      return new Error(
        "手机浏览器拦截了自动播放。请再点一次「继续朗读」；若仍失败，请检查是否静音并允许网站播放声音。",
      );
    }
    return err instanceof Error ? err : new Error(msg || "音频播放失败");
  }
  return new Error("音频播放失败");
}
