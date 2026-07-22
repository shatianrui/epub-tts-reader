type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

import {
  startBackgroundPlayback,
  stopBackgroundPlayback,
  updateBackgroundPlayback,
} from "./backgroundPlayback";

/** Tiny silent WAV used to unlock HTMLAudioElement on iOS Safari. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

export type PreparedAudio = {
  kind: "raw";
  buffer: ArrayBuffer;
};

export type MediaSessionHandlers = {
  play?: () => void;
  pause?: () => void;
  nexttrack?: () => void;
  previoustrack?: () => void;
};

/**
 * Mobile-friendly audio player based on HTMLAudioElement.
 * Prefer HTMLAudioElement over Web Audio so playback continues when the tab
 * is backgrounded (AudioContext is typically suspended on hide).
 * iOS Safari blocks Audio.play() after async work unless unlocked
 * during the original user gesture — call unlock() synchronously on click.
 */
export class MobileAudioPlayer {
  private element: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private unlocked = false;
  private playToken = 0;
  private settleCurrent: ((reason: "ended" | "stopped" | "error") => void) | null =
    null;

  /** Call synchronously inside a click/touch handler. */
  unlock(): void {
    // Touch AudioContext briefly so some browsers keep the page "media active"
    const Win = window as AudioWindow;
    const AC = window.AudioContext || Win.webkitAudioContext;
    if (AC) {
      try {
        const ctx = new AC();
        void ctx.resume().then(() => {
          void ctx.close();
        });
      } catch {
        /* ignore */
      }
    }

    if (!this.element) {
      this.element = this.createElement();
    }

    // Kick HTMLAudioElement unlock while user gesture is still active
    this.element.src = SILENT_WAV;
    const playPromise = this.element.play();
    if (playPromise) {
      void playPromise
        .then(() => {
          this.element?.pause();
          if (this.element) this.element.currentTime = 0;
        })
        .catch(() => {
          /* ignore — real playback may still work after another tap */
        });
    }

    this.unlocked = true;
  }

  private createElement(): HTMLAudioElement {
    const el = new Audio();
    // Keep inline on mobile, but still allow OS media session / background
    el.setAttribute("playsinline", "true");
    el.setAttribute("webkit-playsinline", "true");
    el.preload = "auto";
    // Helps some mobile browsers treat this as ongoing media
    el.setAttribute("x-webkit-airplay", "allow");
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

  /** Keep original bytes for HTMLAudioElement (background-safe) playback. */
  async prepare(buffer: ArrayBuffer): Promise<PreparedAudio> {
    return { kind: "raw", buffer };
  }

  async playPrepared(prepared: PreparedAudio): Promise<void> {
    if (!this.unlocked) {
      throw new Error(
        "请先点击「继续朗读」按钮开始播放（手机浏览器需要手动触发声音）",
      );
    }

    if (!this.element) {
      this.element = this.createElement();
    }

    // Cancel any in-flight clip so callers never hang on pause/seek
    this.finishPlayback("stopped");
    const token = ++this.playToken;

    this.element.pause();
    this.revokeUrl();
    const blob = new Blob([prepared.buffer], { type: "audio/mpeg" });
    this.objectUrl = URL.createObjectURL(blob);
    this.element.src = this.objectUrl;
    this.element.load();

    const outcome = await new Promise<"ended" | "stopped" | "error">(
      (resolve, reject) => {
        const el = this.element!;
        const onEnded = () => this.finishPlayback("ended");
        const onError = () => this.finishPlayback("error");

        this.settleCurrent = (reason) => {
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
          resolve(reason);
        };

        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onError);

        void el.play().catch((err: unknown) => {
          if (token !== this.playToken) {
            this.finishPlayback("stopped");
            return;
          }
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
          this.settleCurrent = null;
          reject(normalizePlayError(err));
        });
      },
    );

    if (token !== this.playToken || outcome === "stopped") {
      return;
    }
    if (outcome === "error") {
      throw new Error("音频播放失败");
    }
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
  void updateBackgroundPlayback({
    title: meta.title,
    subtitle: meta.artist || meta.album || "EPUB 朗读中",
    playing: true,
  });

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
  meta?: { title?: string; subtitle?: string },
): void {
  if (state === "playing") {
    void startBackgroundPlayback({
      title: meta?.title || "听页 ListenPage",
      subtitle: meta?.subtitle || "EPUB 朗读中",
    });
  } else if (state === "paused") {
    void updateBackgroundPlayback({
      title: meta?.title,
      subtitle: meta?.subtitle || "已暂停",
      playing: false,
    });
  } else {
    void stopBackgroundPlayback();
  }

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
