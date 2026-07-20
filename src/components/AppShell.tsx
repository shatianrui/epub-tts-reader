"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppSettings, ReadingProgress, StoredBook } from "@/lib/types";
import { deleteBook, getProgress, listBooks, saveBook } from "@/lib/db";
import { parseEpub } from "@/lib/epub";
import { loadSettings } from "@/lib/settings";
import { Reader } from "@/components/Reader";
import { SettingsPanel } from "@/components/SettingsPanel";

function formatDate(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AppShell() {
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

  useEffect(() => {
    void refresh();
    setSettings(loadSettings());
  }, [refresh]);

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
    await refresh();
  }

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
      </>
    );
  }

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-bg" aria-hidden />
        <div className="hero-inner">
          <p className="brand">听页 ListenPage</p>
          <h1>把 EPUB 变成可续听的有声书</h1>
          <p className="hero-sub">
            上传电子书，接入 MiniMax Token Plan 语音合成，记住进度、随时续读。
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
          {!settings.apiKey && (
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
          <p>或将 .epub 拖放到此处 · 书籍会保存在本机浏览器中</p>
        </section>

        {uploadError && <p className="form-error">{uploadError}</p>}

        <section className="library">
          <div className="section-head">
            <h2>我的书库</h2>
            <span>{ready ? `${books.length} 本` : "加载中…"}</span>
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
    </div>
  );
}
