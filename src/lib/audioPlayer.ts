type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/** Tiny silent WAV used to unlock HTMLAudioElement on iOS Safari. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

/** Look-ahead when scheduling on AudioContext timeline (seconds). */
const SCHEDULE_AHEAD_SEC = 0.04;

/** Short crossfade hides MP3 encoder padding / click at joins. */
const CROSSFADE_SEC = 0.014;

/** Tail pad when duration comes from decoded PCM / API timestamps. */
const TAIL_PAD_TRUSTED_MS = 40;

/** Tail pad when duration is only a byte-rate estimate (HTML / early ended). */
const TAIL_PAD_ESTIMATE_MS = 280;

/** Never trust an `ended` that fires before this fraction of expected duration. */
const EARLY_END_RATIO = 0.92;

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

function pickDurationFloor(
  knownDuration: number,
  elementDuration: number,
  byteEstimate: number,
): number {
  const candidates = [knownDuration, elementDuration, byteEstimate].filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  if (candidates.length === 0) return 0;
  return Math.max(...candidates);
}

function flattenPrepared(prepared: PreparedAudio): PreparedClip[] {
  if (prepared.kind === "sequence") return prepared.parts;
  return [prepared];
}

function tailPadMs(trust: DurationTrust): number {
  return trust === "estimate" ? TAIL_PAD_ESTIMATE_MS : TAIL_PAD_TRUSTED_MS;
}

function maxTrust(parts: PreparedClip[]): DurationTrust {
  if (parts.some((p) => p.trust === "estimate")) return "estimate";
  if (parts.some((p) => p.trust === "api")) return "api";
  return "decoded";
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

  /** Call synchronously inside a click/touch handler. */
  unlock(): void {
    const AC = getAudioContextConstructor();
    if (AC) {
      if (!this.ctx || this.ctx.state === "closed") {
        this.ctx = new AC();
        this.masterGain = null;
      }
      void this.ctx.resume();
      this.ensureMasterGain();
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
        if (document.visibilityState === "visible") {
          if (this.ctx) void this.ctx.resume();
          const cur = this.elements[this.activeEl];
          if (cur && cur.paused && this.settleCurrent) {
            void cur.play().catch(() => undefined);
          }
        }
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }

    this.unlocked = true;
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
      const durationSec = Math.max(
        hintDuration || 0,
        decoded.duration,
        byteEstimate,
      );
      const trust: DurationTrust =
        decoded.duration > 0
          ? "decoded"
          : durationTrusted && hintDuration
            ? "api"
            : "estimate";
      return {
        kind: "decoded",
        audioBuffer: decoded,
        raw: buffer,
        durationSec,
        mimeType,
        trust,
      };
    } catch {
      return {
        kind: "raw",
        buffer,
        durationSec: Math.max(hintDuration || 0, byteEstimate) || undefined,
        mimeType,
        trust: durationTrusted && hintDuration ? "api" : "estimate",
      };
    }
  }

  async playPrepared(
    prepared: PreparedAudio,
    opts: PlayPreparedOptions = {},
  ): Promise<void> {
    if (!this.unlocked) {
      throw new Error(
        "请先点击「继续朗读」按钮开始播放（手机浏览器需要手动触发声音）",
      );
    }

    const gapAfterMs = Math.max(0, opts.gapAfterMs ?? 0);
    const parts = flattenPrepared(prepared);
    if (parts.length === 0) return;

    const allDecoded =
      parts.every((p) => p.kind === "decoded") &&
      !!this.ctx &&
      this.ctx.state !== "closed";

    if (allDecoded) {
      if (this.ctx!.state === "suspended") {
        await this.ctx!.resume().catch(() => undefined);
      }
      if (this.ctx!.state === "running") {
        const ok = await this.playDecodedTimeline(
          parts as Extract<PreparedClip, { kind: "decoded" }>[],
          gapAfterMs,
        );
        if (ok) return;
      }
    }

    // HTMLAudio path (single or multi-part with dual-element handoff)
    const gen = this.generation;
    for (let i = 0; i < parts.length; i++) {
      if (this.generation !== gen) return;
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const partGap = isLast ? gapAfterMs : 0;
      const raw = part.kind === "decoded" ? part.raw : part.buffer;
      const token = ++this.playToken;
      await this.playHtmlWithGate(
        raw,
        part.durationSec ?? 0,
        part.mimeType || "audio/mpeg",
        part.trust,
        token,
        partGap,
      );
    }
  }

  /**
   * Schedule decoded buffers back-to-back on the AudioContext clock with a
   * short crossfade. gapAfterMs is included in the waited timeline so the
   * next playPrepared call can start exactly when the pause ends.
   */
  private async playDecodedTimeline(
    parts: Extract<PreparedClip, { kind: "decoded" }>[],
    gapAfterMs: number,
  ): Promise<boolean> {
    if (!this.ctx || this.ctx.state !== "running") return false;
    const gainMaster = this.ensureMasterGain();
    if (!gainMaster) return false;

    this.finishPlayback("stopped");
    const token = ++this.playToken;
    const gen = this.generation;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Continue from previous timeline when still in the future (gapless chain).
    const chaining = this.timelineEnd > now + 0.001;
    if (!chaining) {
      this.stopSources();
    }
    let t = chaining ? this.timelineEnd : now + SCHEDULE_AHEAD_SEC;
    const fade = CROSSFADE_SEC;

    try {
      for (let i = 0; i < parts.length; i++) {
        const audioBuffer = parts[i].audioBuffer;
        const dur = Math.max(audioBuffer.duration, parts[i].durationSec || 0);
        if (dur <= 0) continue;

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(gainMaster);

        const startAt = i === 0 ? t : Math.max(t - fade, now);
        const fadeInEnd = startAt + Math.min(fade, dur * 0.25);
        const fadeOutStart = startAt + Math.max(dur - fade, dur * 0.5);

        gain.gain.setValueAtTime(i === 0 ? 1 : 0.0001, startAt);
        if (i > 0) {
          gain.gain.linearRampToValueAtTime(1, fadeInEnd);
        }
        if (i < parts.length - 1 && dur > fade * 2) {
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

        t = startAt + dur;
      }
    } catch {
      this.stopSources();
      return false;
    }

    if (this.activeSources.length === 0) return false;

    const trust = maxTrust(parts);
    const padSec = tailPadMs(trust) / 1000;
    const gapSec = gapAfterMs / 1000;
    // Next clip may schedule at timelineEnd — keep gap on the audio clock.
    this.timelineEnd = t + gapSec;
    // Gapless handoff: resolve slightly before audio ends when no pause, so the
    // next playPrepared can schedule on the same timeline with crossfade.
    // With a pause, resolve when the silence ends (no extra pad stacked).
    const waitUntil =
      gapSec > 0
        ? this.timelineEnd
        : Math.max(t - SCHEDULE_AHEAD_SEC, t + padSec - SCHEDULE_AHEAD_SEC * 2);

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
          // Keep context alive in background tabs
          if (this.ctx.state === "suspended") {
            void this.ctx.resume().catch(() => undefined);
          }
          if (this.ctx.currentTime >= waitUntil - 0.005) {
            done("ended");
          }
        }, 24);
      },
    );

    if (token !== this.playToken || outcome === "stopped") {
      return true;
    }
    if (outcome === "error") throw new Error("音频播放失败");

    // Keep timelineEnd for the next gapless schedule. Sources self-remove onended
    // so early handoff can crossfade into the next clip.
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
          const floor = pickDurationFloor(
            knownDuration,
            safeElementDuration(),
            byteEstimate,
          );
          return floor > 0 ? floor * 1000 : 0;
        };

        const tryFinish = () => {
          if (finished || token !== this.playToken) {
            if (token !== this.playToken) done("stopped");
            return;
          }

          const need = expectedMs();
          const elapsed = performance.now() - startedAt;

          if (need > 0 && elapsed < need * EARLY_END_RATIO) {
            if (el.paused && !el.ended) {
              void el.play().catch(() => undefined);
            }
            return;
          }

          if (need > 0 && elapsed < need - 20) {
            if (padTimer == null) {
              padTimer = window.setTimeout(() => {
                padTimer = null;
                tryFinish();
              }, Math.max(20, need - elapsed + padMs));
            }
            return;
          }

          if (padTimer == null) {
            padTimer = window.setTimeout(() => {
              padTimer = null;
              done("ended");
            }, padMs);
          }
        };

        const onEnded = () => {
          endedSignal = true;
          tryFinish();
        };

        const onTimeUpdate = () => {
          const dur = safeElementDuration();
          if (dur > 0 && el.currentTime >= dur - 0.05) {
            tryFinish();
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

          if (need > 0 && elapsed >= need + padMs) {
            if (
              endedSignal ||
              el.ended ||
              el.paused ||
              (safeElementDuration() > 0 &&
                el.currentTime >= safeElementDuration() - 0.12)
            ) {
              done("ended");
              return;
            }
            if (elapsed >= need + 2000) {
              done("ended");
            }
            return;
          }

          if (need <= 0 && endedSignal) {
            tryFinish();
          }
        }, 40);

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
    this.stopSources();
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
