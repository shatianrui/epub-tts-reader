type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/** Tiny silent WAV used to unlock HTMLAudioElement on iOS Safari. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

/**
 * Extra wait after a clip is considered finished.
 * Covers MP3 decoder padding / early `ended` quirks so the last
 * syllables are heard before the reader advances.
 */
const TAIL_PAD_MS = 450;

/** Never trust an `ended` that fires before this fraction of expected duration. */
const EARLY_END_RATIO = 0.92;

export type PreparedAudio = {
  kind: "decoded";
  audioBuffer: AudioBuffer;
  raw: ArrayBuffer;
  durationSec: number;
  mimeType: string;
} | {
  kind: "raw";
  buffer: ArrayBuffer;
  durationSec?: number;
  mimeType: string;
};

export type PrepareInput = {
  buffer: ArrayBuffer;
  durationSec?: number;
  mimeType?: string;
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
  // MiniMax uses 128kbps; Grok often similar. Use 128kbps as baseline,
  // and a slightly slower 96kbps estimate so we wait a bit longer if unsure.
  const sec128 = (bytes.byteLength * 8) / 128_000;
  const sec96 = (bytes.byteLength * 8) / 96_000;
  // Prefer the longer estimate as a floor (safer against early advance).
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

/**
 * HTMLAudio-first player with a hard wall-clock gate.
 * Never advances to the next paragraph before the expected clip duration
 * has elapsed — even if the browser fires `ended` early on TTS MP3 blobs.
 */
export class MobileAudioPlayer {
  private ctx: AudioContext | null = null;
  private element: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private unlocked = false;
  private playToken = 0;
  private settleCurrent: ((reason: "ended" | "stopped" | "error") => void) | null =
    null;
  private visibilityHandler: (() => void) | null = null;

  /** Call synchronously inside a click/touch handler. */
  unlock(): void {
    const AC = getAudioContextConstructor();
    if (AC) {
      if (!this.ctx || this.ctx.state === "closed") {
        this.ctx = new AC();
      }
      void this.ctx.resume();
    }

    if (!this.element) {
      this.element = this.createElement();
    }

    this.element.src = SILENT_WAV;
    const playPromise = this.element.play();
    if (playPromise) {
      void playPromise
        .then(() => {
          this.element?.pause();
          if (this.element) this.element.currentTime = 0;
        })
        .catch(() => {
          /* ignore */
        });
    }

    if (!this.visibilityHandler && typeof document !== "undefined") {
      this.visibilityHandler = () => {
        if (document.visibilityState === "visible") {
          if (this.ctx) void this.ctx.resume();
          // Keep HTMLAudio warm after returning to the tab
          if (this.element && this.element.paused && this.settleCurrent) {
            void this.element.play().catch(() => undefined);
          }
        }
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }

    this.unlocked = true;
  }

  private createElement(): HTMLAudioElement {
    const el = new Audio();
    el.setAttribute("playsinline", "true");
    el.setAttribute("webkit-playsinline", "true");
    el.preload = "auto";
    el.setAttribute("x-webkit-airplay", "allow");
    // Some mobile browsers only fire reliable media events when the
    // element is in the document.
    if (typeof document !== "undefined" && !el.isConnected) {
      el.style.display = "none";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    }
    return el;
  }

  private revokeUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private finishPlayback(reason: "ended" | "stopped" | "error"): void {
    const settle = this.settleCurrent;
    this.settleCurrent = null;
    settle?.(reason);
  }

  async prepare(input: ArrayBuffer | PrepareInput): Promise<PreparedAudio> {
    const buffer = input instanceof ArrayBuffer ? input : input.buffer;
    const hintDuration =
      input instanceof ArrayBuffer ? undefined : input.durationSec;
    const mimeType =
      (input instanceof ArrayBuffer ? undefined : input.mimeType) ||
      "audio/mpeg";
    const byteEstimate = estimateMp3DurationSec(buffer);
    const AC = getAudioContextConstructor();
    if (!AC) {
      return {
        kind: "raw",
        buffer,
        durationSec: Math.max(hintDuration || 0, byteEstimate) || undefined,
        mimeType,
      };
    }

    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => undefined);
    }

    try {
      const decoded = await this.ctx.decodeAudioData(buffer.slice(0));
      // Use the longest credible estimate — decodeAudioData can trim
      // encoder padding and under-report; API duration is authoritative.
      const durationSec = Math.max(
        decoded.duration,
        byteEstimate,
        hintDuration || 0,
      );
      return {
        kind: "decoded",
        audioBuffer: decoded,
        raw: buffer,
        durationSec,
        mimeType,
      };
    } catch {
      return {
        kind: "raw",
        buffer,
        durationSec: Math.max(hintDuration || 0, byteEstimate) || undefined,
        mimeType,
      };
    }
  }

  async playPrepared(prepared: PreparedAudio): Promise<void> {
    if (!this.unlocked) {
      throw new Error(
        "请先点击「继续朗读」按钮开始播放（手机浏览器需要手动触发声音）",
      );
    }

    this.finishPlayback("stopped");
    const token = ++this.playToken;

    const raw =
      prepared.kind === "decoded" ? prepared.raw : prepared.buffer;
    const knownDuration = prepared.durationSec ?? 0;

    await this.playHtmlWithGate(
      raw,
      knownDuration,
      prepared.mimeType || "audio/mpeg",
      token,
    );
  }

  private async playHtmlWithGate(
    buffer: ArrayBuffer,
    knownDuration: number,
    mimeType: string,
    token: number,
  ): Promise<void> {
    if (!this.element) {
      this.element = this.createElement();
    }

    const el = this.element;
    el.pause();
    this.revokeUrl();
    const blob = new Blob([buffer], { type: mimeType || "audio/mpeg" });
    this.objectUrl = URL.createObjectURL(blob);
    el.src = this.objectUrl;
    el.load();

    const byteEstimate = estimateMp3DurationSec(buffer);
    const startedAt = performance.now();

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
      window.setTimeout(resolve, 1200);
    });

    if (token !== this.playToken) return;

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
            Number.isFinite(el.duration) ? el.duration : 0,
            byteEstimate,
          );
          return floor > 0 ? floor * 1000 : 0;
        };

        const tryFinish = (from: "ended" | "near-end" | "gate") => {
          if (finished || token !== this.playToken) {
            if (token !== this.playToken) done("stopped");
            return;
          }

          const need = expectedMs();
          const elapsed = performance.now() - startedAt;

          // Hard rule: never advance before the expected duration floor.
          if (need > 0 && elapsed < need * EARLY_END_RATIO) {
            if (el.paused && !el.ended) {
              void el.play().catch(() => undefined);
            }
            return;
          }

          if (need > 0 && elapsed < need - 40) {
            if (padTimer == null) {
              padTimer = window.setTimeout(() => {
                padTimer = null;
                tryFinish(from);
              }, Math.max(40, need - elapsed + TAIL_PAD_MS));
            }
            return;
          }

          if (padTimer == null) {
            padTimer = window.setTimeout(() => {
              padTimer = null;
              done("ended");
            }, TAIL_PAD_MS);
          }
        };

        const onEnded = () => {
          endedSignal = true;
          tryFinish("ended");
        };

        const onTimeUpdate = () => {
          const dur =
            Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
          if (dur > 0 && el.currentTime >= dur - 0.08) {
            tryFinish("near-end");
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

          if (need > 0 && elapsed >= need + TAIL_PAD_MS) {
            if (
              endedSignal ||
              el.ended ||
              el.paused ||
              (Number.isFinite(el.duration) &&
                el.duration > 0 &&
                el.currentTime >= el.duration - 0.15)
            ) {
              done("ended");
              return;
            }
            if (elapsed >= need + 2500) {
              done("ended");
            }
            return;
          }

          if (need <= 0 && endedSignal) {
            tryFinish("ended");
          }
        }, 50);

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
  }

  async playArrayBuffer(buffer: ArrayBuffer): Promise<void> {
    const prepared = await this.prepare(buffer);
    await this.playPrepared(prepared);
  }

  stop(): void {
    this.playToken += 1;
    this.finishPlayback("stopped");
    if (this.element) {
      this.element.pause();
      this.element.removeAttribute("src");
      try {
        this.element.load();
      } catch {
        /* ignore */
      }
    }
    this.revokeUrl();
  }

  isPlaying(): boolean {
    return !!this.element && !this.element.paused && !this.element.ended;
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
