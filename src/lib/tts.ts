import type { AppSettings, VoiceOption } from "./types";
import { FALLBACK_VOICES } from "./types";

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

export async function fetchVoices(
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

export async function synthesizeSpeech(
  text: string,
  settings: AppSettings,
): Promise<ArrayBuffer> {
  if (!settings.apiKey?.trim()) {
    throw new Error("请先在设置中填写 MiniMax Token Plan API Key");
  }
  if (!text?.trim()) {
    throw new Error("朗读文本为空");
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
