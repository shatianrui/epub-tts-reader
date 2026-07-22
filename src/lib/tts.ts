import type { AppSettings, VoiceOption } from "./types";
import {
  FALLBACK_VOICES,
  GROK_FALLBACK_VOICES,
  getActiveApiKey,
  getFallbackVoices,
} from "./types";

const GROK_API_BASE = "https://api.x.ai";

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/\s/g, "");
  const len = clean.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

function buildMinimaxUrl(apiBase: string, path: string, groupId?: string) {
  const base = apiBase.replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  if (groupId?.trim()) {
    url.searchParams.set("GroupId", groupId.trim());
  }
  return url.toString();
}

async function parseErrorResponse(res: Response, provider: string): Promise<string> {
  const raw = await res.text();
  try {
    const json = JSON.parse(raw) as {
      error?: { message?: string };
      base_resp?: { status_msg?: string };
      message?: string;
    };
    return (
      json.error?.message ||
      json.base_resp?.status_msg ||
      json.message ||
      `${provider} 请求失败 (${res.status})`
    );
  } catch {
    return raw.slice(0, 200) || `${provider} 请求失败 (${res.status})`;
  }
}

async function fetchMinimaxVoices(
  settings: Pick<AppSettings, "minimaxApiKey" | "apiBase" | "groupId">,
): Promise<VoiceOption[]> {
  if (!settings.minimaxApiKey?.trim()) {
    throw new Error("请先填写 MiniMax API Key");
  }

  const res = await fetch(
    buildMinimaxUrl(settings.apiBase, "/v1/get_voice", settings.groupId),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.minimaxApiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ voice_type: "all" }),
    },
  );

  const json = await res.json();
  const statusCode = json.base_resp?.status_code ?? 0;
  if (!res.ok || statusCode !== 0) {
    return FALLBACK_VOICES;
  }

  const voices: VoiceOption[] = [];
  for (const v of json.system_voice || []) {
    voices.push({
      voice_id: v.voice_id,
      voice_name: v.voice_name,
      description: v.description,
      category: "system",
    });
  }
  for (const v of json.voice_cloning || []) {
    voices.push({
      voice_id: v.voice_id,
      voice_name: v.voice_id,
      description: v.description,
      category: "voice_cloning",
    });
  }
  for (const v of json.voice_generation || []) {
    voices.push({
      voice_id: v.voice_id,
      voice_name: v.voice_id,
      description: v.description,
      category: "voice_generation",
    });
  }

  voices.sort((a, b) => {
    const aZh = /chinese|mandarin|中文|普通话/i.test(
      `${a.voice_id} ${a.voice_name || ""}`,
    )
      ? 0
      : 1;
    const bZh = /chinese|mandarin|中文|普通话/i.test(
      `${b.voice_id} ${b.voice_name || ""}`,
    )
      ? 0
      : 1;
    return aZh - bZh;
  });

  return voices.length > 0 ? voices : FALLBACK_VOICES;
}

async function fetchGrokVoices(
  settings: Pick<AppSettings, "grokApiKey">,
): Promise<VoiceOption[]> {
  if (!settings.grokApiKey?.trim()) {
    throw new Error("请先填写 Grok / xAI API Key");
  }

  const res = await fetch(`${GROK_API_BASE}/v1/tts/voices`, {
    headers: {
      Authorization: `Bearer ${settings.grokApiKey.trim()}`,
    },
  });

  if (!res.ok) {
    return GROK_FALLBACK_VOICES;
  }

  const json = (await res.json()) as {
    voices?: Array<{ voice_id: string; name?: string; language?: string | null }>;
  };

  const voices = (json.voices || []).map((voice) => ({
    voice_id: voice.voice_id,
    voice_name: voice.name || voice.voice_id,
    description: voice.language ? [`语言：${voice.language}`] : undefined,
    category: "grok" as const,
  }));

  return voices.length > 0 ? voices : GROK_FALLBACK_VOICES;
}

export async function fetchVoices(settings: AppSettings): Promise<VoiceOption[]> {
  if (settings.ttsProvider === "grok") {
    return fetchGrokVoices(settings);
  }
  return fetchMinimaxVoices(settings);
}

async function synthesizeMinimax(
  text: string,
  settings: AppSettings,
): Promise<ArrayBuffer> {
  if (!settings.minimaxApiKey?.trim()) {
    throw new Error("请先在设置中填写 MiniMax Token Plan API Key");
  }

  const clipped = text.slice(0, 9000);
  const res = await fetch(
    buildMinimaxUrl(settings.apiBase, "/v1/t2a_v2", settings.groupId),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.minimaxApiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model || "speech-2.8-turbo",
        text: clipped,
        stream: false,
        language_boost: settings.languageBoost || "auto",
        output_format: "hex",
        voice_setting: {
          voice_id: settings.voiceId,
          speed: Math.min(2, Math.max(0.5, settings.speed || 1)),
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1,
        },
      }),
    },
  );

  const raw = await res.text();
  let json: {
    data?: { audio?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };

  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`MiniMax 返回非 JSON：${raw.slice(0, 200)}`);
  }

  const statusCode = json.base_resp?.status_code ?? 0;
  if (!res.ok || statusCode !== 0) {
    throw new Error(
      json.base_resp?.status_msg || `MiniMax 请求失败 (${res.status})`,
    );
  }

  const audioHex = json.data?.audio;
  if (!audioHex) {
    throw new Error("MiniMax 未返回音频数据");
  }

  return hexToArrayBuffer(audioHex);
}

async function synthesizeGrok(
  text: string,
  settings: AppSettings,
): Promise<ArrayBuffer> {
  if (!settings.grokApiKey?.trim()) {
    throw new Error("请先在设置中填写 Grok / xAI API Key");
  }

  const clipped = text.slice(0, 15000);
  const res = await fetch(`${GROK_API_BASE}/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.grokApiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: clipped,
      voice_id: settings.voiceId || "eve",
      language: settings.grokLanguage || "zh",
      speed: Math.min(1.5, Math.max(0.7, settings.speed || 1)),
      output_format: {
        codec: "mp3",
        sample_rate: 24000,
        bit_rate: 128000,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(await parseErrorResponse(res, "Grok TTS"));
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = (await res.json()) as {
      audio?: string;
      error?: { message?: string };
    };
    if (json.audio) {
      const binary = atob(json.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.buffer;
    }
    throw new Error(json.error?.message || "Grok 未返回音频数据");
  }

  return res.arrayBuffer();
}

export async function synthesizeSpeech(
  text: string,
  settings: AppSettings,
): Promise<ArrayBuffer> {
  if (!getActiveApiKey(settings).trim()) {
    throw new Error(
      settings.ttsProvider === "grok"
        ? "请先在设置中填写 Grok / xAI API Key"
        : "请先在设置中填写 MiniMax Token Plan API Key",
    );
  }
  if (!text?.trim()) {
    throw new Error("朗读文本为空");
  }

  if (settings.ttsProvider === "grok") {
    return synthesizeGrok(text, settings);
  }
  return synthesizeMinimax(text, settings);
}

export function getProviderLabel(provider: AppSettings["ttsProvider"]): string {
  return provider === "grok" ? "Grok TTS" : "MiniMax";
}

export function hasConfiguredApiKey(settings: AppSettings): boolean {
  return Boolean(getActiveApiKey(settings).trim());
}

export { getFallbackVoices };
