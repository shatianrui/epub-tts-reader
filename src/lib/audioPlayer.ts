type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/** Tiny silent WAV used to unlock HTMLAudioElement on iOS Safari. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

/** Extra silence after each clip so the last syllables are never truncated. */
const TAIL_SILENCE_SEC = 0.35;

export type PreparedAudio = {
  kind: "decoded";
  audioBuffer: AudioBuffer;
  /** Original mp3/bytes for HTMLAudio fallback */
  raw: ArrayBuffer;
  durationSec: number;
} | {
  kind: "raw";
  buffer: ArrayBuffer;
  durationSec?: number;
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

function appendSilence(buffer: AudioBuffer, seconds: number): AudioBuffer {
  if (seconds <= 0) return buffer;
  const ctxCtor = getAudioContextConstructor();
  if (!ctxCtor) return buffer;

  // OfflineAudioContext can create buffers without a live context
  const sampleRate = buffer.sampleRate;
  const extra = Math.ceil(seconds * sampleRate);
  const length = buffer.length + extra;
  const offline = new OfflineAudioContext(
    buffer.numberOfChannels,
    length,
    sampleRate,
  );
  const out = offline.createBuffer(
    buffer.numberOfChannels,
    length,
    sampleRate,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dest = out.getChannelData(ch);
    dest.set(src);
    // remaining samples stay 0 (silence)
  }
  return out;
}

/**
 * Prefers Web Audio BufferSource for sample-accurate completion.
 * Falls back to HTMLAudioElement when decode is unavailable.
 * Call unlock() synchronously inside a user gesture.
 */
export class MobileAudioPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
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
        if (document.visibilityState === "visible" && this.ctx) {
          void this.ctx.resume();
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
    return el;
  }

  private revokeUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private stopSource(): void {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
  }

  private finishPlayback(reason: "ended" | "stopped" | "error"): void {
    const settle = this.settleCurrent;
    this.settleCurrent = null;
    settle?.(reason);
  }

  async prepare(buffer: ArrayBuffer): Promise<PreparedAudio> {
    const AC = getAudioContextConstructor();
    if (!AC) {
      return { kind: "raw", buffer };
    }

    // Reuse live context when possible for consistent sample rate
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => undefined);
    }

    try {
      const decoded = await this.ctx.decodeAudioData(buffer.slice(0));
      const padded = appendSilence(decoded, TAIL_SILENCE_SEC);
      return {
        kind: "decoded",
        audioBuffer: padded,
        raw: buffer,
        durationSec: padded.duration,
      };
    } catch {
      return { kind: "raw", buffer };
    }
  }

  async playPrepared(prepared: PreparedAudio): Promise<void> {
    if (!this.unlocked) {
      throw new Error(
        "请先点击「继续朗读」按钮开始播放（手机浏览器需要手动触发声音）",
      );
    }

    this.finishPlayback("stopped");
    this.stopSource();
    const token = ++this.playToken;

    // Prefer Web Audio — onended fires only after every sample is played
    if (prepared.kind === "decoded" && this.ctx) {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume().catch(() => undefined);
      }
      if (this.ctx.state === "closed") {
        const AC = getAudioContextConstructor();
        if (AC) this.ctx = new AC();
      }

      if (this.ctx && this.ctx.state !== "closed") {
        const outcome = await new Promise<"ended" | "stopped" | "error">(
          (resolve, reject) => {
            let finished = false;
            const done = (reason: "ended" | "stopped" | "error") => {
              if (finished) return;
              finished = true;
              this.settleCurrent = null;
              resolve(reason);
            };
            this.settleCurrent = done;

            try {
              const source = this.ctx!.createBufferSource();
              this.source = source;
              source.buffer = prepared.audioBuffer;
              source.connect(this.ctx!.destination);
              source.onended = () => {
                if (this.source === source) this.source = null;
                if (token !== this.playToken) {
                  done("stopped");
                  return;
                }
                done("ended");
              };
              source.start(0);
            } catch (err) {
              this.settleCurrent = null;
              finished = true;
              reject(err instanceof Error ? err : new Error("音频播放失败"));
            }
          },
        );

        if (token !== this.playToken || outcome === "stopped") return;
        if (outcome === "error") throw new Error("音频播放失败");
        return;
      }
    }

    // Fallback: HTMLAudioElement + hard wall-clock gate using decoded duration
    await this.playHtmlFallback(
      prepared.kind === "decoded" ? prepared.raw : prepared.buffer,
      prepared.durationSec ?? 0,
      token,
    );
  }

  private async playHtmlFallback(
    buffer: ArrayBuffer,
    knownDuration: number,
    token: number,
  ): Promise<void> {
    if (!this.element) {
      this.element = this.createElement();
    }

    this.element.pause();
    this.revokeUrl();
    const blob = new Blob([buffer], { type: "audio/mpeg" });
    this.objectUrl = URL.createObjectURL(blob);
    this.element.src = this.objectUrl;
    this.element.load();

    const el = this.element;
    const startedAt = performance.now();

    // Wait until media can play
    await new Promise<void>((resolve) => {
      if (el.readyState >= 2) {
        resolve();
        return;
      }
      const onReady = () => {
        el.removeEventListener("canplay", onReady);
        resolve();
      };
      el.addEventListener("canplay", onReady);
      window.setTimeout(resolve, 800);
    });

    if (token !== this.playToken) return;

    const outcome = await new Promise<"ended" | "stopped" | "error">(
      (resolve, reject) => {
        let finished = false;
        let endedOnce = false;

        const cleanup = () => {
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
          window.clearInterval(gate);
        };

        const done = (reason: "ended" | "stopped" | "error") => {
          if (finished) return;
          finished = true;
          cleanup();
          this.settleCurrent = null;
          resolve(reason);
        };

        this.settleCurrent = done;

        const minMs =
          knownDuration > 0
            ? knownDuration * 1000 + TAIL_SILENCE_SEC * 1000
            : 0;

        const onEnded = () => {
          endedOnce = true;
          // Do not finish yet if wall-clock duration not reached — keep waiting
          // (audio may have stopped; gate will still delay next paragraph)
          const elapsed = performance.now() - startedAt;
          if (minMs > 0 && elapsed < minMs - 30) {
            // Try resume; if file truly ended, gate handles the wait
            void el.play().catch(() => undefined);
            return;
          }
          window.setTimeout(() => done("ended"), 80);
        };

        const onError = () => done("error");

        const gate = window.setInterval(() => {
          if (token !== this.playToken) {
            done("stopped");
            return;
          }
          if (finished) return;

          const elapsed = performance.now() - startedAt;
          const duration =
            knownDuration > 0
              ? knownDuration
              : Number.isFinite(el.duration) && el.duration > 0
                ? el.duration
                : 0;

          // Absolute rule: never advance before decoded/reported duration
          if (duration > 0 && elapsed < duration * 1000 + 200) {
            return;
          }

          if (endedOnce || el.ended || (duration > 0 && elapsed >= duration * 1000 + 280)) {
            done("ended");
          }
        }, 40);

        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onError);

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
    this.stopSource();
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
    if (this.source) return true;
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
