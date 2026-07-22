export type TtsProvider = "minimax" | "grok";

export interface BookChapter {
  id: string;
  href: string;
  title: string;
  paragraphs: string[];
}

export interface StoredBook {
  id: string;
  title: string;
  author: string;
  coverDataUrl?: string;
  fileName: string;
  epubData: ArrayBuffer;
  chapters: BookChapter[];
  createdAt: number;
  updatedAt: number;
}

export interface ReadingProgress {
  bookId: string;
  chapterIndex: number;
  paragraphIndex: number;
  updatedAt: number;
}

export interface AppSettings {
  ttsProvider: TtsProvider;
  minimaxApiKey: string;
  grokApiKey: string;
  apiBase: string;
  groupId: string;
  voiceId: string;
  model: string;
  speed: number;
  languageBoost: string;
  grokLanguage: string;
  autoNextChapter: boolean;
  chapterGap: number;
}

export interface VoiceOption {
  voice_id: string;
  voice_name?: string;
  description?: string[];
  category: "system" | "voice_cloning" | "voice_generation" | "grok";
}

export const DEFAULT_SETTINGS: AppSettings = {
  ttsProvider: "minimax",
  minimaxApiKey: "",
  grokApiKey: "",
  apiBase: "https://api.minimaxi.com",
  groupId: "",
  voiceId: "Chinese (Mandarin)_News_Anchor",
  model: "speech-2.8-turbo",
  speed: 1,
  languageBoost: "Chinese",
  grokLanguage: "zh",
  autoNextChapter: true,
  chapterGap: 0,
};

export const TTS_PROVIDER_OPTIONS = [
  { label: "MiniMax Token Plan", value: "minimax" as const },
  { label: "Grok TTS (xAI)", value: "grok" as const },
] as const;

export const API_BASE_OPTIONS = [
  { label: "国内节点 (api.minimaxi.com)", value: "https://api.minimaxi.com" },
  { label: "国际节点 (api.minimax.io)", value: "https://api.minimax.io" },
] as const;

export const MODEL_OPTIONS = [
  { label: "speech-2.8-turbo（推荐）", value: "speech-2.8-turbo" },
  { label: "speech-2.8-hd", value: "speech-2.8-hd" },
  { label: "speech-2.6-turbo", value: "speech-2.6-turbo" },
  { label: "speech-2.6-hd", value: "speech-2.6-hd" },
] as const;

export const GROK_LANGUAGE_OPTIONS = [
  { label: "中文", value: "zh" },
  { label: "自动检测", value: "auto" },
  { label: "English", value: "en" },
  { label: "日本語", value: "ja" },
  { label: "한국어", value: "ko" },
  { label: "Français", value: "fr" },
  { label: "Deutsch", value: "de" },
  { label: "Español", value: "es" },
] as const;

export const FALLBACK_VOICES: VoiceOption[] = [
  {
    voice_id: "Chinese (Mandarin)_News_Anchor",
    voice_name: "新闻女声",
    description: ["专业播音腔，适合小说朗读"],
    category: "system",
  },
  {
    voice_id: "Chinese (Mandarin)_Reliable_Executive",
    voice_name: "沉稳男声",
    description: ["沉稳可靠的男声"],
    category: "system",
  },
  {
    voice_id: "Chinese (Mandarin)_Gentle_Senior",
    voice_name: "温和长辈",
    description: ["温和亲切"],
    category: "system",
  },
  {
    voice_id: "Chinese (Mandarin)_Warm_Girl",
    voice_name: "温暖少女",
    description: ["温暖自然的女声"],
    category: "system",
  },
  {
    voice_id: "Chinese (Mandarin)_Male_Announcer",
    voice_name: "男播音",
    description: ["清晰男播音"],
    category: "system",
  },
  {
    voice_id: "Chinese (Mandarin)_Sweet_Lady",
    voice_name: "甜美女声",
    description: ["甜美柔和"],
    category: "system",
  },
];

export const GROK_FALLBACK_VOICES: VoiceOption[] = [
  { voice_id: "eve", voice_name: "Eve", description: ["温暖自然，默认女声"], category: "grok" },
  { voice_id: "ara", voice_name: "Ara", description: ["清晰专业"], category: "grok" },
  { voice_id: "leo", voice_name: "Leo", description: ["沉稳男声"], category: "grok" },
  { voice_id: "rex", voice_name: "Rex", description: ["有力播报感"], category: "grok" },
  { voice_id: "sal", voice_name: "Sal", description: ["友好亲切"], category: "grok" },
  { voice_id: "luna", voice_name: "Luna", description: ["柔和舒缓"], category: "grok" },
  { voice_id: "orion", voice_name: "Orion", description: ["沉稳叙述"], category: "grok" },
  { voice_id: "carina", voice_name: "Carina", description: ["客服支持风格"], category: "grok" },
  { voice_id: "atlas", voice_name: "Atlas", description: ["教育讲解"], category: "grok" },
  { voice_id: "lumen", voice_name: "Lumen", description: ["明亮清晰"], category: "grok" },
  { voice_id: "helix", voice_name: "Helix", description: ["评论解说"], category: "grok" },
  { voice_id: "castor", voice_name: "Castor", description: ["广告配音"], category: "grok" },
];

export function getActiveApiKey(settings: AppSettings): string {
  return settings.ttsProvider === "grok"
    ? settings.grokApiKey
    : settings.minimaxApiKey;
}

export function getDefaultVoiceId(provider: TtsProvider): string {
  return provider === "grok" ? "eve" : "Chinese (Mandarin)_News_Anchor";
}

export function getFallbackVoices(provider: TtsProvider): VoiceOption[] {
  return provider === "grok" ? GROK_FALLBACK_VOICES : FALLBACK_VOICES;
}

export function getSpeedRange(provider: TtsProvider): { min: number; max: number; step: number } {
  return provider === "grok"
    ? { min: 0.7, max: 1.5, step: 0.05 }
    : { min: 0.5, max: 2, step: 0.1 };
}
