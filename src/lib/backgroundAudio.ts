import { Capacitor } from "@capacitor/core";

type NativeClip = {
  buffer: ArrayBuffer;
  mimeType?: string;
  id?: string;
  gapAfterMs?: number;
};

type ListenPageAudioApi = {
  enqueue(opts: {
    base64: string;
    mimeType?: string;
    id?: string;
    gapAfterMs?: number;
  }): Promise<{ id?: string }>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setGapMs(opts: { ms: number }): Promise<void>;
  isPlaying(): Promise<{
    playing: boolean;
    queueLength: number;
    currentId?: string;
  }>;
};

declare global {
  interface Window {
    ListenPageAudio?: ListenPageAudioApi;
  }
}

export function isNativeIosAudio(): boolean {
  return (
    typeof window !== "undefined" &&
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "ios"
  );
}

function getNativeApi(): ListenPageAudioApi | null {
  if (typeof window === "undefined") return null;
  return window.ListenPageAudio ?? null;
}

/** True when the WKWebView message bridge injected ListenPageAudio. */
export async function nativeIosAudioAvailable(): Promise<boolean> {
  if (!isNativeIosAudio()) return false;
  // Bootstrap script injects at document start; retry briefly if racey.
  for (let i = 0; i < 20; i++) {
    const api = getNativeApi();
    if (api?.isPlaying) {
      try {
        await api.isPlaying();
        return true;
      } catch {
        /* keep trying */
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function onNativeEvent(
  handler: (name: string, data: Record<string, unknown>) => void,
): () => void {
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent).detail as {
      name?: string;
      data?: Record<string, unknown>;
    };
    if (detail?.name) handler(detail.name, detail.data || {});
  };
  window.addEventListener("listenpage-audio", listener);
  return () => window.removeEventListener("listenpage-audio", listener);
}

/**
 * Play clips via native AVAudioPlayer queue (lock-screen / background safe).
 */
export async function playNativeQueue(
  clips: NativeClip[],
  opts: {
    onTrackStart?: (index: number, id: string) => void;
    shouldContinue?: () => boolean;
  } = {},
): Promise<void> {
  if (clips.length === 0) return;

  const api = getNativeApi();
  if (!api) {
    throw new Error("ListenPageAudio bridge not available");
  }

  const ids = clips.map((c, i) => c.id || `clip-${i}-${Date.now()}`);
  const idToIndex = new Map(ids.map((id, i) => [id, i]));
  let ended = 0;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      off();
      if (err) reject(err);
      else resolve();
    };

    const off = onNativeEvent((name, data) => {
      if (opts.shouldContinue && !opts.shouldContinue()) {
        void api.stop();
        finish();
        return;
      }
      if (name === "trackStart") {
        const id = typeof data.id === "string" ? data.id : "";
        const idx = idToIndex.get(id);
        if (idx != null) opts.onTrackStart?.(idx, id);
      } else if (name === "trackEnded") {
        ended += 1;
        if (ended >= clips.length) finish();
      } else if (name === "queueEmpty") {
        finish();
      } else if (name === "error") {
        if (ended === 0 && clips.length === 1) {
          const msg =
            typeof data.message === "string"
              ? data.message
              : "原生音频播放失败";
          finish(new Error(msg));
        }
      } else if (name === "stopped") {
        finish();
      }
    });

    void (async () => {
      try {
        for (let i = 0; i < clips.length; i++) {
          if (opts.shouldContinue && !opts.shouldContinue()) {
            await api.stop();
            finish();
            return;
          }
          await api.enqueue({
            base64: arrayBufferToBase64(clips[i].buffer),
            mimeType: clips[i].mimeType || "audio/mpeg",
            id: ids[i],
            gapAfterMs: Math.max(0, clips[i].gapAfterMs ?? 0),
          });
        }
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

export async function stopNativeAudio(): Promise<void> {
  if (!isNativeIosAudio()) return;
  try {
    await getNativeApi()?.stop();
  } catch {
    /* ignore */
  }
}
