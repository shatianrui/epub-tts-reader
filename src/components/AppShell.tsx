"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppSettings, ReadingProgress, StoredBook } from "@/lib/types";
import { deleteBook, getProgress, listBooks, saveBook } from "@/lib/db";
import { parseEpub } from "@/lib/epub";
import { loadSettings } from "@/lib/settings";
import { Reader } from "@/components/Reader";
import { SettingsPanel } from "@/components/SettingsPanel";
import { AuthPanel } from "@/components/AuthPanel";
import { useAuth } from "@/lib/auth";
import { hasConfiguredApiKey } from "@/lib/tts";
import { syncAll, uploadBook, removeBookFromCloud } from "@/lib/sync";

function formatDate(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AppShell() {
  const { user, isLoading: authLoading, signOut, configured } = useAuth();
  const [books, setBooks] = useState<StoredBook[]>([]);
  const [progressMap, setProgressMap] = useState<
    Record<string, ReadingProgress>
  >({});
  const [activeBook, setActiveBook] = useState<StoredBook | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [ready, setReady] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<"login" | "signup">("login");
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const refresh = useCallback(async () => {
    const list = await listBooks();
    setBooks(list);
    const map: Record<string, ReadingProgress> = {};
    await Promise.all(
      list.map(async (b) => {
        const p = await getProgress(b.id);
        if (p) map[b.id] = p;
      }),
    );
    setProgressMap(map);
    setReady(true);
  }, []);

  const handleSync = useCallback(async () => {
    if (!user) return;
    setSyncing(true);
    setSyncMessage("");
    try {
      const result = await syncAll();
      const parts: string[] = [];
      if (result.booksSynced > 0) parts.push(`${result.booksSynced} 本书籍`);
      if (result.progressSynced > 0) parts.push(`${result.progressSynced} 条进度`);
      if (result.settingsSynced) parts.push("设置");
      if (parts.length > 0) {
        setSyncMessage(`已同步 ${parts.join("、")}`);
      } else if (result.errors.length === 0) {
        setSyncMessage("数据已是最新");
      }
      if (result.errors.length > 0) {
        console.warn("同步错误:", result.errors);
      }
      await refresh();
    } catch (e) {
      setSyncMessage(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMessage(""), 3000);
    }
  }, [user, refresh]);

  useEffect(() => {
    void refresh();
    setSettings(loadSettings());
  }, [refresh]);

  useEffect(() => {
    if (user && !authLoading) {
      void handleSync();
    }
  }, [user, authLoading, handleSync]);

  useEffect(() => {
    if (!user) return;

    const interval = setInterval(() => {
      void handleSync();
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [user, handleSync]);

  useEffect(() => {
    if (!user) return;

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void handleSync();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [user, handleSync]);

  async function handleFiles(files: FileList | File[]) {
    const file = Array.from(files).find((f) =>
      f.name.toLowerCase().endsWith(".epub"),
    );
    if (!file) {
      setUploadError("请上传 .epub 文件");
      return;
    }

    setUploading(true);
    setUploadError("");
    try {
      const data = await file.arrayBuffer();
      const parsed = await parseEpub(data);
      const now = Date.now();
      const book: StoredBook = {
        id: crypto.randomUUID(),
        title: parsed.title,
        author: parsed.author,
        coverDataUrl: parsed.coverDataUrl,
        fileName: file.name,
        epubData: data,
        chapters: parsed.chapters,
        createdAt: now,
        updatedAt: now,
      };
      await saveBook(book);
      if (user) {
        void uploadBook(book);
      }
      await refresh();
      setActiveBook(book);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "解析 EPUB 失败");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("确定删除这本电子书及其阅读进度？")) return;
    await deleteBook(id);
    if (activeBook?.id === id) setActiveBook(null);
    if (user) {
      void removeBookFromCloud(id);
    }
    await refresh();
  }

  function openLogin() {
    setAuthModalMode("login");
    setAuthModalOpen(true);
    setUserMenuOpen(false);
  }

  function openSignup() {
    setAuthModalMode("signup");
    setAuthModalOpen(true);
    setUserMenuOpen(false);
  }

  async function handleSignOut() {
    await signOut();
    setUserMenuOpen(false);
  }

  const userEmail = user?.email ?? "";
  const userInitial = userEmail ? userEmail[0].toUpperCase() : "?";

  if (activeBook) {
    return (
      <>
        <Reader
          book={activeBook}
          initialProgress={progressMap[activeBook.id]}
          settings={settings}
          onOpenSettings={() => setSettingsOpen(true)}
          onBack={() => {
            void refresh();
            setActiveBook(null);
          }}
        />
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => setSettings(s)}
        />
        <AuthPanel
          open={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          initialMode={authModalMode}
        />
      </>
    );
  }

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-bg" aria-hidden />
        <div className="hero-inner">
          <div className="hero-top-bar">
            <p className="brand">听页 ListenPage</p>
            <div className="user-area">
              {syncMessage && <span className="sync-message">{syncMessage}</span>}
              {!configured ? (
                <span className="user-loading" title="未配置 NEXT_PUBLIC_SUPABASE_URL">
                  云端未配置
                </span>
              ) : authLoading ? (
                <span className="user-loading">加载中…</span>
              ) : user ? (
                <div className="user-menu">
                  <button
                    type="button"
                    className="user-avatar"
                    onClick={() => setUserMenuOpen((v) => !v)}
                    title={userEmail}
                  >
                    {userInitial}
                  </button>
                  {userMenuOpen && (
                    <div className="user-dropdown">
                      <div className="user-dropdown-header">
                        <span className="user-email">{userEmail}</span>
                      </div>
                      <button
                        type="button"
                        className="dropdown-item"
                        onClick={() => {
                          void handleSync();
                          setUserMenuOpen(false);
                        }}
                        disabled={syncing}
                      >
                        {syncing ? "同步中…" : "同步数据"}
                      </button>
                      <button
                        type="button"
                        className="dropdown-item danger"
                        onClick={handleSignOut}
                      >
                        退出登录
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="auth-buttons">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={openLogin}
                  >
                    登录
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={openSignup}
                  >
                    注册
                  </button>
                </div>
              )}
            </div>
          </div>
          <h1>把 EPUB 变成可续听的有声书</h1>
          <p className="hero-sub">
            上传电子书，支持 MiniMax 与 Grok TTS 语音朗读，记住进度、随时续读。
            {user && " 登录后数据将同步到云端。"}
          </p>
          <div className="hero-actions">
            <label className="btn-primary upload-label">
              {uploading ? "解析中…" : "上传 EPUB"}
              <input
                type="file"
                accept=".epub,application/epub+zip"
                hidden
                disabled={uploading}
                onChange={(e) => {
                  if (e.target.files) void handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setSettingsOpen(true)}
            >
              配置 API / 语音
            </button>
          </div>
          {!hasConfiguredApiKey(settings) && (
            <p className="hero-hint">尚未配置 API Key，朗读前请先完成设置。</p>
          )}
        </div>
      </header>

      <main className="main">
        <section
          className={`dropzone ${dragOver ? "is-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) {
              void handleFiles(e.dataTransfer.files);
            }
          }}
        >
          <p>
            或将 .epub 拖放到此处 · 书籍会保存在本机浏览器中
            {user && "，并同步到云端"}
          </p>
        </section>

        {uploadError && <p className="form-error">{uploadError}</p>}

        <section className="library">
          <div className="section-head">
            <h2>我的书库</h2>
            <div className="section-head-right">
              {user && (
                <button
                  type="button"
                  className="btn-sync"
                  onClick={() => void handleSync()}
                  disabled={syncing}
                >
                  {syncing ? "同步中…" : "同步"}
                </button>
              )}
              <span>{ready ? `${books.length} 本` : "加载中…"}</span>
            </div>
          </div>

          {ready && books.length === 0 && (
            <p className="empty">还没有电子书，上传一本开始听读吧。</p>
          )}

          <div className="book-grid">
            {books.map((book) => {
              const progress = progressMap[book.id];
              const totalParas = book.chapters.reduce(
                (n, c) => n + c.paragraphs.length,
                0,
              );
              let done = 0;
              if (progress) {
                for (let i = 0; i < progress.chapterIndex; i++) {
                  done += book.chapters[i]?.paragraphs.length || 0;
                }
                done += progress.paragraphIndex;
              }
              const pct =
                totalParas > 0
                  ? Math.min(100, Math.round((done / totalParas) * 100))
                  : 0;

              return (
                <button
                  type="button"
                  key={book.id}
                  className="book-item"
                  onClick={() => setActiveBook(book)}
                >
                  <div
                    className="book-cover"
                    style={
                      book.coverDataUrl
                        ? {
                            backgroundImage: `url(${book.coverDataUrl})`,
                          }
                        : undefined
                    }
                  >
                    {!book.coverDataUrl && (
                      <span>{book.title.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="book-meta">
                    <strong>{book.title}</strong>
                    <span>{book.author}</span>
                    <span className="muted">
                      {book.chapters.length} 章 · {formatDate(book.updatedAt)}
                    </span>
                    {progress && (
                      <div className="progress-line">
                        <div style={{ width: `${pct}%` }} />
                        <em>
                          续读第 {progress.chapterIndex + 1} 章 · {pct}%
                        </em>
                      </div>
                    )}
                  </div>
                  <span
                    className="delete-btn"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(book.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleDelete(book.id);
                      }
                    }}
                  >
                    删除
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => setSettings(s)}
      />
      <AuthPanel
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        initialMode={authModalMode}
      />
    </div>
  );
}
