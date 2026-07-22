"use client";

import { useEffect, useState } from "react";
import type { AppSettings, TtsProvider, VoiceOption } from "@/lib/types";
import {
  API_BASE_OPTIONS,
  GROK_LANGUAGE_OPTIONS,
  MODEL_OPTIONS,
  TTS_PROVIDER_OPTIONS,
  getDefaultVoiceId,
  getFallbackVoices,
  getSpeedRange,
} from "@/lib/types";
import { loadSettings, saveSettings } from "@/lib/settings";
import { fetchVoices, hasConfiguredApiKey } from "@/lib/tts";
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
  const [voices, setVoices] = useState<VoiceOption[]>(
    getFallbackVoices(loadSettings().ttsProvider),
  );
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const speedRange = getSpeedRange(settings.ttsProvider);
  const isGrok = settings.ttsProvider === "grok";

  useEffect(() => {
    if (open) {
      const loaded = loadSettings();
      setSettings(loaded);
      setVoices(getFallbackVoices(loaded.ttsProvider));
      setMessage("");
      setError("");
    }
  }, [open]);

  function handleProviderChange(provider: TtsProvider) {
    setSettings((current) => ({
      ...current,
      ttsProvider: provider,
      voiceId: getDefaultVoiceId(provider),
      speed: Math.min(
        getSpeedRange(provider).max,
        Math.max(getSpeedRange(provider).min, current.speed || 1),
      ),
    }));
    setVoices(getFallbackVoices(provider));
    setMessage("");
    setError("");
  }

  async function handleLoadVoices() {
    setLoadingVoices(true);
    setError("");
    setMessage("");
    try {
      const list = await fetchVoices(settings);
      setVoices(list);
      setMessage(`已加载 ${list.length} 个语音`);
      if (
        list.length > 0 &&
        !list.some((v) => v.voice_id === settings.voiceId)
      ) {
        setSettings((s) => ({ ...s, voiceId: list[0].voice_id }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载语音失败");
      setVoices(getFallbackVoices(settings.ttsProvider));
    } finally {
      setLoadingVoices(false);
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

  const activeKey = isGrok ? settings.grokApiKey : settings.minimaxApiKey;

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
            <span>语音服务</span>
            <div className="provider-grid">
              {TTS_PROVIDER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={
                    settings.ttsProvider === opt.value
                      ? "provider-chip is-active"
                      : "provider-chip"
                  }
                  onClick={() => handleProviderChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </label>

          {isGrok ? (
            <label className="field">
              <span>Grok / xAI API Key</span>
              <input
                type="password"
                value={settings.grokApiKey}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, grokApiKey: e.target.value }))
                }
                placeholder="xai-..."
                autoComplete="off"
              />
              <small>在 console.x.ai 获取 API Key，使用 Grok TTS 语音合成</small>
            </label>
          ) : (
            <>
              <label className="field">
                <span>MiniMax Token Plan API Key</span>
                <input
                  type="password"
                  value={settings.minimaxApiKey}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      minimaxApiKey: e.target.value,
                    }))
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
            </>
          )}

          {isGrok && (
            <label className="field">
              <span>朗读语言</span>
              <select
                value={settings.grokLanguage}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, grokLanguage: e.target.value }))
                }
              >
                {GROK_LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="field">
            <div className="field-row">
              <span>朗读人物</span>
              <button
                type="button"
                className="text-btn"
                onClick={handleLoadVoices}
                disabled={loadingVoices || !activeKey.trim()}
              >
                {loadingVoices ? "加载中…" : "刷新语音列表"}
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
                  {v.description?.[0] ? ` · ${v.description[0]}` : ""}
                </option>
              ))}
            </select>
          </div>

          <label className="field">
            <span>
              语速：{settings.speed.toFixed(isGrok ? 2 : 1)}x
              {isGrok ? "（Grok 范围 0.7–1.5）" : ""}
            </span>
            <input
              type="range"
              min={speedRange.min}
              max={speedRange.max}
              step={speedRange.step}
              value={settings.speed}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  speed: Number(e.target.value),
                }))
              }
            />
          </label>

          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={settings.autoNextChapter}
              onChange={(e) =>
                setSettings((s) => ({ ...s, autoNextChapter: e.target.checked }))
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
          <button
            type="button"
            className="btn-primary"
            onClick={handleSave}
            disabled={!hasConfiguredApiKey(settings)}
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
