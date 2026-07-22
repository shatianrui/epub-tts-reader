import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS_KEY = "epub-tts-settings";
const SETTINGS_UPDATED_AT_KEY = "epub-tts-settings-updated-at";

/** Merge partial / legacy stored settings with defaults. */
export function normalizeSettings(
  partial?: Partial<AppSettings> | null,
): AppSettings {
  return { ...DEFAULT_SETTINGS, ...(partial || {}) };
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify(normalizeSettings(settings)),
  );
  localStorage.setItem(SETTINGS_UPDATED_AT_KEY, String(Date.now()));
}

export function getSettingsUpdatedAt(): number {
  if (typeof window === "undefined") return 0;
  return Number(localStorage.getItem(SETTINGS_UPDATED_AT_KEY) || "0");
}

/** Prefer non-empty local secrets when cloud payload has blank keys. */
export function mergeSettingsPreferLocalSecrets(
  cloud: Partial<AppSettings> | null | undefined,
  local: AppSettings,
): AppSettings {
  const merged = normalizeSettings(cloud);
  if (!merged.apiKey?.trim() && local.apiKey?.trim()) {
    merged.apiKey = local.apiKey;
  }
  if (!merged.grokApiKey?.trim() && local.grokApiKey?.trim()) {
    merged.grokApiKey = local.grokApiKey;
  }
  if (!merged.groupId?.trim() && local.groupId?.trim()) {
    merged.groupId = local.groupId;
  }
  return merged;
}

export function maskApiKey(key: string): string {
  const t = key.trim();
  if (!t) return "（未保存）";
  if (t.length <= 8) return `${t.slice(0, 2)}…已保存`;
  return `${t.slice(0, 4)}…${t.slice(-4)}（已保存）`;
}
