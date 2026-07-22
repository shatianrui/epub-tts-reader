"use client";

import { useEffect, useState } from "react";
import type { AppSettings, TtsProvider, VoiceOption } from "@/lib/types";
import {
  API_BASE_OPTIONS,
  FALLBACK_VOICES,
  GROK_LANGUAGE_OPTIONS,
  GROK_VOICES,
  MODEL_OPTIONS,
  TTS_PROVIDER_OPTIONS,
} from "@/lib/types";
import { loadSettings, saveSettings } from "@/lib/settings";
import { fetchGrokVoices, fetchMiniMaxVoices, testGrokConnection } from "@/lib/tts";
import { useAuth } from "@/lib/auth";
import { pushSettings } from "@/lib/sync";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: AppSettings) => void;
}

export function SettingsPanel({ open, onClose, onSaved }: SettingsPanelProps) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [voices, setVoices] = useState<VoiceOption[]>(FALLBACK_VOICES);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const loaded = loadSettings();
    setSettings(loaded);
    setMessage("");
    setError("");
    setVoices(
      loaded.ttsProvider === "grok" ? GROK_VOICES : FALLBACK_VOICES,
    );
  }, [open]);

  function switchProvider(provider: TtsProvider) {
    setSettings((s) => {
      if (provider === s.ttsProvider) return s;
      if (provider === "grok") {
        setVoices(GROK_VOICES);
        return {
          ...s,
          ttsProvider: "grok",
          grokVoiceId: s.grokVoiceId || "eve",
          // Grok only supports 0.7–1.5
          speed: Math.min(1.5, Math.max(0.7, s.speed || 1)),
        };
      }
      setVoices(FALLBACK_VOICES);
      return {
        ...s,
        ttsProvider: "minimax",
        voiceId: s.voiceId || FALLBACK_VOICES[0].voice_id,
      };
    });
  }

  async function handleLoadVoices() {
    setLoadingVoices(true);
    setError("");
    setMessage("");
    try {
      if (settings.ttsProvider === "grok") {
        const list = await fetchGrokVoices(settings);
        setVoices(list);
        setMessage(`已加载 ${list.length} 个 Grok 语音`);
        if (
          list.length > 0 &&
          !list.some((v) => v.voice_id === settings.grokVoiceId)
        ) {
          setSettings((s) => ({ ...s, grokVoiceId: list[0].voice_id }));
        }
      } else {
        const list = await fetchMiniMaxVoices(settings);
        setVoices(list);
        setMessage(`已加载 ${list.length} 个语音`);
        if (
          list.length > 0 &&
          !list.some((v) => v.voice_id === settings.voiceId)
        ) {
          setSettings((s) => ({ ...s, voiceId: list[0].voice_id }));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载语音失败");
      setVoices(
        settings.ttsProvider === "grok" ? GROK_VOICES : FALLBACK_VOICES,
      );
    } finally {
      setLoadingVoices(false);
    }
  }

  async function handleTestGrok() {
    setTesting(true);
    setError("");
    setMessage("");
    const result = await testGrokConnection(settings);
    setTesting(false);
    if (result.ok) {
      setMessage("Grok 连接成功，可以开始朗读。");
    } else {
      setError(result.error);
    }
  }

  function handleSave() {
    saveSettings(settings);
    onSaved?.(settings);
    if (user) {
      void pushSettings(settings);
    }
    setMessage("设置已保存");
    setTimeout(() => onClose(), 400);
  }

  if (!open) return null;

  const isGrok = settings.ttsProvider === "grok";
  const canRefreshVoices = isGrok
    ? Boolean(settings.grokApiKey.trim())
    : Boolean(settings.apiKey.trim());

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-header">
          <h2 id="settings-title">朗读设置</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="settings-body">
          <label className="field">
            <span>语音引擎</span>
            <select
              value={settings.ttsProvider}
              onChange={(e) =>
                switchProvider(e.target.value as TtsProvider)
              }
            >
              {TTS_PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          {isGrok ? (
            <>
              <label className="field">
                <span>Grok / xAI API Key</span>
                <input
                  type="password"
                  value={settings.grokApiKey}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, grokApiKey: e.target.value }))
                  }
                  placeholder="xAI API Key"
                  autoComplete="off"
                />
                <small>
                  在 console.x.ai → API Keys 创建。国内若连不上，请开代理或填写下方反向代理。
                </small>
              </label>

              <label className="field">
                <span>API 地址（可选反向代理）</span>
                <input
                  type="url"
                  value={settings.grokApiBase}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, grokApiBase: e.target.value }))
                  }
                  placeholder="https://api.x.ai"
                />
                <small>默认 https://api.x.ai，可改为你自己的代理前缀</small>
              </label>

              <div className="field-row" style={{ marginBottom: "0.35rem" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void handleTestGrok()}
                  disabled={testing || !settings.grokApiKey.trim()}
                >
                  {testing ? "测试中…" : "测试 Grok 连接"}
                </button>
              </div>

              <label className="field">
                <span>朗读语言</span>
                <select
                  value={settings.grokLanguage}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      grokLanguage: e.target.value,
                    }))
                  }
                >
                  {GROK_LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="field">
                <div className="field-row">
                  <span>语音人物</span>
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => void handleLoadVoices()}
                    disabled={loadingVoices || !canRefreshVoices}
                  >
                    {loadingVoices ? "加载中…" : "从 API 刷新"}
                  </button>
                </div>
                <select
                  value={settings.grokVoiceId}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      grokVoiceId: e.target.value,
                    }))
                  }
                >
                  {(voices.length ? voices : GROK_VOICES).map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.voice_name || v.voice_id}
                      {v.description?.[0] ? ` · ${v.description[0]}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <label className="field">
                <span>语速：{settings.speed.toFixed(1)}x（Grok 范围 0.7–1.5）</span>
                <input
                  type="range"
                  min={0.7}
                  max={1.5}
                  step={0.1}
                  value={Math.min(1.5, Math.max(0.7, settings.speed || 1))}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      speed: Number(e.target.value),
                    }))
                  }
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>MiniMax Token Plan API Key</span>
                <input
                  type="password"
                  value={settings.apiKey}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, apiKey: e.target.value }))
                  }
                  placeholder="Subscription Key / API Key"
                  autoComplete="off"
                />
                <small>
                  在 MiniMax 控制台 Billing → Token Plan 获取 Subscription Key
                </small>
              </label>

              <label className="field">
                <span>API 节点</span>
                <select
                  value={settings.apiBase}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, apiBase: e.target.value }))
                  }
                >
                  {API_BASE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>GroupId（国内账号可选）</span>
                <input
                  type="text"
                  value={settings.groupId}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, groupId: e.target.value }))
                  }
                  placeholder="如控制台要求则填写"
                />
              </label>

              <label className="field">
                <span>语音模型</span>
                <select
                  value={settings.model}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, model: e.target.value }))
                  }
                >
                  {MODEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="field">
                <div className="field-row">
                  <span>朗读语音</span>
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => void handleLoadVoices()}
                    disabled={loadingVoices || !canRefreshVoices}
                  >
                    {loadingVoices ? "加载中…" : "从 API 刷新语音"}
                  </button>
                </div>
                <select
                  value={settings.voiceId}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, voiceId: e.target.value }))
                  }
                >
                  {voices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.voice_name || v.voice_id}
                      {v.category !== "system" ? ` (${v.category})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <label className="field">
                <span>语速：{settings.speed.toFixed(1)}x</span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={settings.speed}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      speed: Number(e.target.value),
                    }))
                  }
                />
              </label>
            </>
          )}

          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={settings.autoNextChapter}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  autoNextChapter: e.target.checked,
                }))
              }
            />
            <span>自动朗读下一章</span>
          </label>

          <label className="field">
            <span>章节间隔：{settings.chapterGap} 秒</span>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={settings.chapterGap}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  chapterGap: Number(e.target.value),
                }))
              }
              disabled={!settings.autoNextChapter}
            />
            <small>开启自动下一章后，每章结束后暂停的秒数</small>
          </label>

          {error && <p className="form-error">{error}</p>}
          {message && <p className="form-ok">{message}</p>}
        </div>

        <footer className="settings-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={handleSave}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
