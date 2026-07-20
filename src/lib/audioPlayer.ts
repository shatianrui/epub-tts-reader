type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/** Tiny silent WAV used to unlock HTMLAudioElement on iOS Safari. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

/**
 * Mobile-friendly audio player.
 * iOS Safari blocks Audio.play() after async work unless unlocked
 * during the original user gesture — call unlock() synchronously on click.
 */
export class MobileAudioPlayer {
  private ctx: AudioContext | null = null;
  private element: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private source: AudioBufferSourceNode | null = null;
  private unlocked = false;

  /** Call synchronously inside a click/touch handler. */
  unlock(): void {
    const Win = window as AudioWindow;
    const AC = window.AudioContext || Win.webkitAudioContext;
    if (AC) {
      if (!this.ctx || this.ctx.state === "closed") {
        this.ctx = new AC();
      }
      void this.ctx.resume();
    }

    if (!this.element) {
      this.element = new Audio();
      this.element.setAttribute("playsinline", "true");
      this.element.setAttribute("webkit-playsinline", "true");
      this.element.preload = "auto";
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
          /* ignore — Web Audio path may still work */
        });
    }

    this.unlocked = true;
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

  private revokeUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  async playArrayBuffer(buffer: ArrayBuffer): Promise<void> {
    if (!this.unlocked) {
      throw new Error(
        "请先点击「继续朗读」按钮开始播放（手机浏览器需要手动触发声音）",
      );
    }

    // Prefer Web Audio API — more reliable after async TTS on iOS
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
      this.stopSource();
      const copy = buffer.slice(0);
      const audioBuffer = await this.ctx.decodeAudioData(copy);

      await new Promise<void>((resolve, reject) => {
        const source = this.ctx!.createBufferSource();
        this.source = source;
        source.buffer = audioBuffer;
        source.connect(this.ctx!.destination);
        source.onended = () => {
          if (this.source === source) this.source = null;
          resolve();
        };
        try {
          source.start(0);
        } catch (err) {
          reject(err instanceof Error ? err : new Error("音频播放失败"));
        }
      });
      return;
    }

    // Fallback: reuse a single HTMLAudioElement
    if (!this.element) {
      this.element = new Audio();
      this.element.setAttribute("playsinline", "true");
    }

    this.element.pause();
    this.revokeUrl();
    const blob = new Blob([buffer], { type: "audio/mpeg" });
    this.objectUrl = URL.createObjectURL(blob);
    this.element.src = this.objectUrl;
    this.element.load();

    await new Promise<void>((resolve, reject) => {
      const el = this.element!;
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("音频播放失败"));
      };
      const cleanup = () => {
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
      };
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);
      void el.play().catch((err: unknown) => {
        cleanup();
        reject(normalizePlayError(err));
      });
    });
  }

  stop(): void {
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
