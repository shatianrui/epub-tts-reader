import { registerPlugin, Capacitor } from "@capacitor/core";

interface AudioSessionPlugin {
  activate(): Promise<void>;
}

const AudioSession = registerPlugin<AudioSessionPlugin>("AudioSession");

/**
 * Re-asserts the native AVAudioSession .playback category on iOS so
 * playback continues through the hardware silent/mute switch. WKWebView
 * can reset the session category the first time it plays audio, so this
 * needs to run again right before each playback attempt, not just once
 * at app launch. No-op on web / Android.
 */
export function activateNativeAudioSession(): void {
  if (Capacitor.getPlatform() !== "ios") return;
  void AudioSession.activate().catch(() => {
    /* ignore: e.g. running in an iOS build without this native plugin */
  });
}
