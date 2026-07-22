import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS_KEY = "epub-tts-settings";
const SETTINGS_UPDATED_AT_KEY = "epub-tts-settings-updated-at";

function migrateSettings(raw: Record<string, unknown>): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw } as AppSettings & {
    apiKey?: string;
  };

  if (!merged.minimaxApiKey && merged.apiKey) {
    merged.minimaxApiKey = merged.apiKey;
  }
  if (!merged.ttsProvider) {
    merged.ttsProvider = "minimax";
  }
  if (!merged.grokLanguage) {
    merged.grokLanguage = "zh";
  }
  if (!merged.grokApiKey) {
    merged.grokApiKey = "";
  }

  return merged;
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return migrateSettings(JSON.parse(raw));
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
