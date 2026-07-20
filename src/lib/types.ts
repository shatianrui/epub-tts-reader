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
  apiKey: string;
  apiBase: string;
  groupId: string;
  voiceId: string;
  model: string;
  speed: number;
  languageBoost: string;
}

export interface VoiceOption {
  voice_id: string;
  voice_name?: string;
  description?: string[];
  category: "system" | "voice_cloning" | "voice_generation";
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  apiBase: "https://api.minimaxi.com",
  groupId: "",
  voiceId: "Chinese (Mandarin)_News_Anchor",
  model: "speech-2.8-turbo",
  speed: 1,
  languageBoost: "Chinese",
};

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
