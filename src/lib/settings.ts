import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS_KEY = "epub-tts-settings";
const SETTINGS_UPDATED_AT_KEY = "epub-tts-settings-updated-at";

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(SETTINGS_UPDATED_AT_KEY, String(Date.now()));
}

export function getSettingsUpdatedAt(): number {
  if (typeof window === "undefined") return 0;
  return Number(localStorage.getItem(SETTINGS_UPDATED_AT_KEY) || "0");
}
