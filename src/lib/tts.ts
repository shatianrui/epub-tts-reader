import type { AppSettings, VoiceOption } from "./types";
import { FALLBACK_VOICES } from "./types";

export function isHexString(str: string): boolean {
  const clean = str.replace(/\s/g, "");
  return clean.length > 0 && clean.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(clean);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.replace(/[\r\n\s]/g, "");
  const binaryString = atob(clean);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/\s/g, "");
  const len = Math.floor(clean.length / 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16) || 0;
  }
  return bytes.buffer;
}

export function decodeAudioPayload(data: string): ArrayBuffer {
  const clean = data.trim();
  if (isHexString(clean)) {
    return hexToArrayBuffer(clean);
  }
  return base64ToArrayBuffer(clean);
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
    throw new Error("请先在设置中填写 API Key");
  }
  if (!text?.trim()) {
    throw new Error("朗读文本为空");
  }

  const clipped = text.slice(0, 9000);

  // 1. Try MiniMax T2A v2 Endpoint
  let res = await fetch(
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

  // 2. Fallback to OpenAI / Grok / standard TTS endpoint if /v1/t2a_v2 is 404 or 405
  if (res.status === 404 || res.status === 405) {
    res = await fetch(buildUrl(settings.apiBase, "/v1/audio/speech"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model || "tts-1",
        input: clipped,
        voice: settings.voiceId,
        speed: settings.speed || 1,
      }),
    });
  }

  const contentType = res.headers.get("content-type") || "";

  // Direct binary audio response
  if (
    contentType.includes("audio/") ||
    contentType.includes("application/octet-stream")
  ) {
    if (!res.ok) {
      throw new Error(`TTS 请求失败 (${res.status})`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) {
      throw new Error("TTS 返回了空音频数据");
    }
    return buf;
  }

  // Parse JSON response
  const raw = await res.text();
  let json: Record<string, any>;

  try {
    json = JSON.parse(raw);
  } catch {
    if (res.ok && raw.length > 0) {
      return new TextEncoder().encode(raw).buffer;
    }
    throw new Error(`TTS 返回非 JSON 响应：${raw.slice(0, 200)}`);
  }

  const statusCode = json.base_resp?.status_code ?? 0;
  if (!res.ok || statusCode !== 0) {
    const errorMsg =
      json.base_resp?.status_msg ||
      json.error?.message ||
      json.message ||
      `TTS 请求失败 (${res.status})`;
    throw new Error(errorMsg);
  }

  const audioStr =
    json.data?.audio ||
    json.audio ||
    json.b64_json ||
    json.data?.[0]?.b64_json;

  if (!audioStr || typeof audioStr !== "string") {
    throw new Error("TTS 未返回有效音频数据");
  }

  const audioBuffer = decodeAudioPayload(audioStr);
  if (audioBuffer.byteLength === 0) {
    throw new Error("解码 TTS 音频数据失败");
  }

  return audioBuffer;
}
