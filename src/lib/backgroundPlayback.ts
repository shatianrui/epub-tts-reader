import { Capacitor, registerPlugin } from "@capacitor/core";

interface BackgroundAudioPlugin {
  start(options: {
    title?: string;
    subtitle?: string;
    playing?: boolean;
  }): Promise<void>;
  update(options: {
    title?: string;
    subtitle?: string;
    playing?: boolean;
  }): Promise<void>;
  stop(): Promise<void>;
}

const BackgroundAudio = registerPlugin<BackgroundAudioPlugin>("BackgroundAudio");

let active = false;
let lastMeta = {
  title: "听页 ListenPage",
  subtitle: "EPUB 朗读中",
};

function isAndroidNative(): boolean {
  return Capacitor.getPlatform() === "android";
}

export async function startBackgroundPlayback(meta: {
  title: string;
  subtitle?: string;
}): Promise<void> {
  if (!isAndroidNative()) return;
  active = true;
  lastMeta = {
    title: meta.title,
    subtitle: meta.subtitle || "EPUB 朗读中",
  };
  try {
    await BackgroundAudio.start({
      title: lastMeta.title,
      subtitle: lastMeta.subtitle,
      playing: true,
    });
  } catch (err) {
    console.warn("后台播放服务启动失败:", err);
  }
}

export async function updateBackgroundPlayback(meta: {
  title?: string;
  subtitle?: string;
  playing: boolean;
}): Promise<void> {
  if (!isAndroidNative()) return;
  if (meta.title) lastMeta.title = meta.title;
  if (meta.subtitle) lastMeta.subtitle = meta.subtitle;
  if (!active && meta.playing) active = true;
  if (!active) return;
  try {
    await BackgroundAudio.update({
      title: lastMeta.title,
      subtitle: meta.playing ? lastMeta.subtitle : "已暂停",
      playing: meta.playing,
    });
  } catch (err) {
    console.warn("后台播放服务更新失败:", err);
  }
}

export async function stopBackgroundPlayback(): Promise<void> {
  if (!isAndroidNative() || !active) return;
  active = false;
  try {
    await BackgroundAudio.stop();
  } catch (err) {
    console.warn("后台播放服务停止失败:", err);
  }
}
