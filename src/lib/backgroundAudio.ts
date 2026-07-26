import { Capacitor, registerPlugin } from "@capacitor/core";

export type BackgroundAudioPlugin = {
  enqueue(options: {
    base64: string;
    mimeType?: string;
    id?: string;
    gapAfterMs?: number;
  }): Promise<{ id: string }>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setGapMs(options: { ms: number }): Promise<void>;
  isPlaying(): Promise<{
    playing: boolean;
    queueLength: number;
    currentId?: string;
  }>;
  addListener(
    eventName:
      | "trackStart"
      | "trackEnded"
      | "queueEmpty"
      | "stopped"
      | "error"
      | "enqueued"
      | "paused"
      | "resumed",
    listenerFunc: (data: Record<string, unknown>) => void,
  ): Promise<{ remove: () => void }>;
};

const BackgroundAudio = registerPlugin<BackgroundAudioPlugin>("BackgroundAudio");

export function isNativeIosAudio(): boolean {
  return (
    typeof window !== "undefined" &&
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "ios"
  );
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

/**
 * Play a list of raw audio buffers on the native iOS queue.
 * Resolves when every clip has finished (or stop/error).
 * Native AVAudioPlayer keeps speaking after lock-screen / background.
 */
export async function playNativeQueue(
  clips: {
    buffer: ArrayBuffer;
    mimeType?: string;
    id?: string;
    gapAfterMs?: number;
  }[],
  opts: {
    onTrackStart?: (index: number, id: string) => void;
    shouldContinue?: () => boolean;
  } = {},
): Promise<void> {
  if (clips.length === 0) return;

  const ids = clips.map((c, i) => c.id || `clip-${i}-${Date.now()}`);
  const idToIndex = new Map(ids.map((id, i) => [id, i]));
  let ended = 0;
  let settled = false;
  let removeEnded: (() => void) | undefined;
  let removeEmpty: (() => void) | undefined;
  let removeError: (() => void) | undefined;
  let removeStart: (() => void) | undefined;

  await new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      removeEnded?.();
      removeEmpty?.();
      removeError?.();
      removeStart?.();
      if (err) reject(err);
      else resolve();
    };

    void (async () => {
      try {
        const endedHandle = await BackgroundAudio.addListener(
          "trackEnded",
          () => {
            if (opts.shouldContinue && !opts.shouldContinue()) {
              void BackgroundAudio.stop();
              finish();
              return;
            }
            ended += 1;
            if (ended >= clips.length) finish();
          },
        );
        removeEnded = () => endedHandle.remove();

        const emptyHandle = await BackgroundAudio.addListener(
          "queueEmpty",
          () => {
            finish();
          },
        );
        removeEmpty = () => emptyHandle.remove();

        const errHandle = await BackgroundAudio.addListener("error", (data) => {
          const msg =
            typeof data.message === "string"
              ? data.message
              : "原生音频播放失败";
          if (ended === 0 && clips.length === 1) {
            finish(new Error(msg));
          }
        });
        removeError = () => errHandle.remove();

        const startHandle = await BackgroundAudio.addListener(
          "trackStart",
          (data) => {
            const id = typeof data.id === "string" ? data.id : "";
            const idx = idToIndex.get(id);
            if (idx != null) opts.onTrackStart?.(idx, id);
          },
        );
        removeStart = () => startHandle.remove();

        for (let i = 0; i < clips.length; i++) {
          if (opts.shouldContinue && !opts.shouldContinue()) {
            await BackgroundAudio.stop();
            finish();
            return;
          }
          await BackgroundAudio.enqueue({
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
    await BackgroundAudio.stop();
  } catch {
    /* ignore */
  }
}

export { BackgroundAudio };
