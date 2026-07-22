import type { AppSettings, VoiceOption } from "./types";
import { FALLBACK_VOICES, GROK_VOICES } from "./types";

const GROK_TTS_URL = "https://api.x.ai/v1/tts";
const GROK_VOICES_URL = "https://api.x.ai/v1/tts/voices";

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/\s/g, "");
  const len = clean.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

function buildUrl(apiBase: string, path: string, groupId?: string) {
  const base = apiBase.replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  if (groupId?.trim()) {
    url.searchParams.set("GroupId", groupId.trim());
  }
  return url.toString();
}

export async function fetchMiniMaxVoices(
  settings: Pick<AppSettings, "apiKey" | "apiBase" | "groupId">,
): Promise<VoiceOption[]> {
  if (!settings.apiKey?.trim()) {
    throw new Error("请先填写 MiniMax API Key");
  }

  try {
    const res = await fetch(
      buildUrl(settings.apiBase, "/v1/get_voice", settings.groupId),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey.trim()}`,
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
  } catch {
    return FALLBACK_VOICES;
  }
}

export async function fetchGrokVoices(
  apiKey: string,
): Promise<VoiceOption[]> {
  if (!apiKey.trim()) {
    return GROK_VOICES;
  }

  try {
    const res = await fetch(GROK_VOICES_URL, {
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
    });
    if (!res.ok) return GROK_VOICES;

    const json = await res.json();
    const list = Array.isArray(json)
      ? json
      : Array.isArray(json.voices)
        ? json.voices
        : [];

    if (list.length === 0) return GROK_VOICES;

    const mapped: VoiceOption[] = list.map(
      (v: { voice_id?: string; id?: string; name?: string; description?: string }) => ({
        voice_id: v.voice_id || v.id || "",
        voice_name: v.name || v.voice_id || v.id,
        description: v.description ? [v.description] : undefined,
        category: "grok" as const,
      }),
    ).filter((v: VoiceOption) => Boolean(v.voice_id));

    return mapped.length > 0 ? mapped : GROK_VOICES;
  } catch {
    return GROK_VOICES;
  }
}

/** @deprecated use fetchMiniMaxVoices / fetchGrokVoices */
export async function fetchVoices(
  settings: Pick<AppSettings, "apiKey" | "apiBase" | "groupId">,
): Promise<VoiceOption[]> {
  return fetchMiniMaxVoices(settings);
}

async function synthesizeMiniMax(
  text: string,
  settings: AppSettings,
): Promise<ArrayBuffer> {
  if (!settings.apiKey?.trim()) {
    throw new Error("请先在设置中填写 MiniMax Token Plan API Key");
  }

  const clipped = text.slice(0, 9000);
  const res = await fetch(
    buildUrl(settings.apiBase, "/v1/t2a_v2", settings.groupId),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey.trim()}`,
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

  const clipped = text.slice(0, 14000);
  const res = await fetch(GROK_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.grokApiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: clipped,
      voice_id: settings.grokVoiceId || "eve",
      language: settings.grokLanguage || "zh",
      output_format: {
        codec: "mp3",
        sample_rate: 24000,
        bit_rate: 128000,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let msg = `Grok TTS 请求失败 (${res.status})`;
    try {
      const j = JSON.parse(errText);
      msg = j.error?.message || j.message || msg;
    } catch {
      if (errText) msg = errText.slice(0, 200);
    }
    throw new Error(msg);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = await res.json();
    const b64 = json.audio || json.data?.audio;
    if (!b64) throw new Error("Grok TTS 未返回音频数据");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  return res.arrayBuffer();
}

export async function synthesizeSpeech(
  text: string,
  settings: AppSettings,
): Promise<ArrayBuffer> {
  if (!text?.trim()) {
    throw new Error("朗读文本为空");
  }

  if (settings.ttsProvider === "grok") {
    return synthesizeGrok(text, settings);
  }
  return synthesizeMiniMax(text, settings);
}

export function activeApiKeyConfigured(settings: AppSettings): boolean {
  if (settings.ttsProvider === "grok") {
    return Boolean(settings.grokApiKey?.trim());
  }
  return Boolean(settings.apiKey?.trim());
}
