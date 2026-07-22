import type { AppSettings, VoiceOption } from "./types";
import { FALLBACK_VOICES, GROK_VOICES } from "./types";

const DEFAULT_GROK_BASE = "https://api.x.ai";

/** Keep Grok requests short — long Chinese paragraphs are often truncated. */
const GROK_CHUNK_MAX_CHARS = 280;

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

function grokBase(settings: Pick<AppSettings, "grokApiBase">) {
  const base = (settings.grokApiBase || DEFAULT_GROK_BASE)
    .trim()
    .replace(/\/$/, "");
  return base || DEFAULT_GROK_BASE;
}

function clampGrokSpeed(speed?: number) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.5, Math.max(0.7, n));
}

function networkHint(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /failed to fetch|networkerror|load failed|network request failed|cors/i.test(
      msg,
    )
  ) {
    return new Error(
      "无法连接 Grok / xAI。请检查：① API Key 是否正确；② 网络是否可访问 api.x.ai（国内常需代理）；③ 可在设置里填写反向代理地址。",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

function parseGrokError(status: number, errText: string): string {
  let msg = `Grok TTS 请求失败 (${status})`;
  try {
    const j = JSON.parse(errText);
    const raw = j.error?.message || j.error || j.message || msg;
    msg = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    if (errText) msg = errText.slice(0, 240);
  }
  if (
    status === 401 ||
    /incorrect api key|invalid api key|unauthorized/i.test(msg)
  ) {
    return "Grok API Key 无效，请到 console.x.ai 重新创建并粘贴完整 Key。";
  }
  if (status === 403) {
    return "Grok API 拒绝访问，请确认账号已开通 TTS 且有余额。";
  }
  if (status === 429) {
    return "Grok 请求过于频繁，请稍后再试。";
  }
  return msg;
}

function decodeBase64Audio(b64: string): ArrayBuffer {
  const clean = b64.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Split long paragraphs into sentence-sized chunks so Grok TTS does not
 * truncate the tail of long Chinese passages.
 */
export function splitGrokText(text: string, maxChars = GROK_CHUNK_MAX_CHARS): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const parts: string[] = [];
  let buf = "";

  const flush = () => {
    const t = buf.trim();
    if (t) parts.push(t);
    buf = "";
  };

  const pushPiece = (piece: string) => {
    if (!piece) return;
    if (piece.length <= maxChars) {
      if (!buf) {
        buf = piece;
        return;
      }
      if (buf.length + piece.length <= maxChars) {
        buf += piece;
        return;
      }
      flush();
      buf = piece;
      return;
    }
    flush();
    for (let i = 0; i < piece.length; i += maxChars) {
      parts.push(piece.slice(i, i + maxChars));
    }
  };

  // Split while keeping sentence punctuation with the preceding text.
  const re = /[^。！？；!?;\n]+[。！？；!?;\n]?/g;
  const tokens = cleaned.match(re);
  if (!tokens) {
    for (let i = 0; i < cleaned.length; i += maxChars) {
      parts.push(cleaned.slice(i, i + maxChars));
    }
    return parts;
  }

  for (const token of tokens) {
    pushPiece(token);
  }
  flush();
  return parts.length > 0 ? parts : [cleaned.slice(0, maxChars)];
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
  settings: Pick<AppSettings, "grokApiKey" | "grokApiBase">,
): Promise<VoiceOption[]> {
  if (!settings.grokApiKey?.trim()) {
    return GROK_VOICES;
  }

  try {
    const res = await fetch(`${grokBase(settings)}/v1/tts/voices`, {
      headers: {
        Authorization: `Bearer ${settings.grokApiKey.trim()}`,
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

    const mapped: VoiceOption[] = list
      .map(
        (v: {
          voice_id?: string;
          id?: string;
          name?: string;
          description?: string;
        }) => ({
          voice_id: v.voice_id || v.id || "",
          voice_name: v.name || v.voice_id || v.id,
          description: v.description ? [v.description] : undefined,
          category: "grok" as const,
        }),
      )
      .filter((v: VoiceOption) => Boolean(v.voice_id));

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

export type SynthesizedSpeech = {
  buffer: ArrayBuffer;
  /** Authoritative duration from the TTS API when available. */
  durationSec?: number;
  mimeType?: string;
};

async function synthesizeMiniMax(
  text: string,
  settings: AppSettings,
): Promise<SynthesizedSpeech> {
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

  const buffer = hexToArrayBuffer(audioHex);
  const durationSec = (buffer.byteLength * 8) / 128_000;
  return { buffer, durationSec, mimeType: "audio/mpeg" };
}

type GrokJsonPayload = {
  audio?: string;
  data?: { audio?: string };
  duration?: number;
  content_type?: string;
  audio_timestamps?: {
    graph_chars?: string[];
    graph_times?: Array<[number, number] | number[]>;
  };
};

function durationFromGrokPayload(json: GrokJsonPayload): number | undefined {
  if (typeof json.duration === "number" && json.duration > 0) {
    return json.duration;
  }
  const times = json.audio_timestamps?.graph_times;
  if (!times || times.length === 0) return undefined;
  let maxEnd = 0;
  for (const pair of times) {
    const end = Array.isArray(pair) ? Number(pair[1]) : NaN;
    if (Number.isFinite(end) && end > maxEnd) maxEnd = end;
  }
  return maxEnd > 0 ? maxEnd : undefined;
}

async function synthesizeGrokChunk(
  text: string,
  settings: AppSettings,
  usePreferred = true,
): Promise<SynthesizedSpeech> {
  const speed = clampGrokSpeed(settings.speed);
  const url = `${grokBase(settings)}/v1/tts`;

  const body = usePreferred
    ? {
        text,
        voice_id: settings.grokVoiceId || "eve",
        language: settings.grokLanguage || "zh",
        speed,
        with_timestamps: true,
        text_normalization: true,
        output_format: {
          codec: "wav",
          sample_rate: 24000,
        },
      }
    : {
        text,
        voice_id: settings.grokVoiceId || "eve",
        language: settings.grokLanguage || "zh",
        speed,
        with_timestamps: true,
        output_format: {
          codec: "mp3",
          sample_rate: 24000,
          bit_rate: 128000,
        },
      };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.grokApiKey.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw networkHint(err);
  }

  if (!res.ok) {
    // Retry once with MP3 if the WAV+timestamps request is rejected
    if (usePreferred && (res.status === 400 || res.status === 422)) {
      return synthesizeGrokChunk(text, settings, false);
    }
    const errText = await res.text().catch(() => "");
    throw new Error(parseGrokError(res.status, errText));
  }

  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const json = (await res.json()) as GrokJsonPayload;
    const b64 = json.audio || json.data?.audio;
    if (!b64) throw new Error("Grok TTS 未返回音频数据");
    const buffer = decodeBase64Audio(b64);
    const durationSec = durationFromGrokPayload(json);
    const mimeType =
      typeof json.content_type === "string" && json.content_type
        ? json.content_type
        : usePreferred
          ? "audio/wav"
          : "audio/mpeg";
    return { buffer, durationSec, mimeType };
  }

  const mimeType = contentType.includes("audio/")
    ? contentType.split(";")[0].trim()
    : usePreferred
      ? "audio/wav"
      : "audio/mpeg";
  return { buffer: await res.arrayBuffer(), mimeType };
}

/**
 * Grok synthesis: split long paragraphs into sentence chunks, request WAV
 * with timestamps, and return one clip per chunk so the player can finish
 * every syllable before advancing.
 */
async function synthesizeGrok(
  text: string,
  settings: AppSettings,
): Promise<SynthesizedSpeech | SynthesizedSpeech[]> {
  if (!settings.grokApiKey?.trim()) {
    throw new Error("请先在设置中填写 Grok / xAI API Key");
  }

  const clipped = text.slice(0, 14000);
  const chunks = splitGrokText(clipped);
  const results: SynthesizedSpeech[] = [];

  // Sequential to avoid 429 and keep order stable
  for (const chunk of chunks) {
    results.push(await synthesizeGrokChunk(chunk, settings));
  }

  return results.length === 1 ? results[0] : results;
}

export async function testGrokConnection(
  settings: Pick<
    AppSettings,
    "grokApiKey" | "grokApiBase" | "grokVoiceId" | "grokLanguage"
  >,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!settings.grokApiKey?.trim()) {
    return { ok: false, error: "请先填写 Grok / xAI API Key" };
  }
  try {
    const res = await fetch(`${grokBase(settings)}/v1/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.grokApiKey.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        text: "连接测试。",
        voice_id: settings.grokVoiceId || "eve",
        language: settings.grokLanguage || "zh",
        speed: 1,
        with_timestamps: true,
        output_format: { codec: "wav", sample_rate: 24000 },
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, error: parseGrokError(res.status, errText) };
    }
    // Consume body (JSON or binary)
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const json = (await res.json()) as GrokJsonPayload;
      if (!(json.audio || json.data?.audio)) {
        return { ok: false, error: "Grok 返回异常：缺少音频数据" };
      }
    } else {
      await res.arrayBuffer().catch(() => undefined);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: networkHint(err).message };
  }
}

export async function synthesizeSpeech(
  text: string,
  settings: AppSettings,
): Promise<SynthesizedSpeech | SynthesizedSpeech[]> {
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
