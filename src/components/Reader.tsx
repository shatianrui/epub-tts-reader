"use client";

import { useCallback, useRef, useState } from "react";
import type { AppSettings, ReadingProgress, StoredBook } from "@/lib/types";
import { saveProgress } from "@/lib/db";
import { synthesizeSpeech } from "@/lib/tts";

interface ReaderProps {
  book: StoredBook;
  initialProgress?: ReadingProgress;
  settings: AppSettings;
  onOpenSettings: () => void;
  onBack: () => void;
}

export function Reader({
  book,
  initialProgress,
  settings,
  onOpenSettings,
  onBack,
}: ReaderProps) {
  const [chapterIndex, setChapterIndex] = useState(
    initialProgress?.chapterIndex ?? 0,
  );
  const [paragraphIndex, setParagraphIndex] = useState(
    initialProgress?.paragraphIndex ?? 0,
  );
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("就绪");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const posRef = useRef({
    chapter: initialProgress?.chapterIndex ?? 0,
    paragraph: initialProgress?.paragraphIndex ?? 0,
  });

  const chapter = book.chapters[chapterIndex];

  const persist = useCallback(
    async (c: number, p: number) => {
      await saveProgress({
        bookId: book.id,
        chapterIndex: c,
        paragraphIndex: p,
        updatedAt: Date.now(),
      });
    },
    [book.id],
  );

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    setLoading(false);
    setStatus("已暂停");
    cleanupAudio();
  }, [cleanupAudio]);

  const playFrom = useCallback(
    async (startChapter: number, startParagraph: number) => {
      if (!settings.apiKey.trim()) {
        setError("请先在设置中填写 MiniMax Token Plan API Key");
        onOpenSettings();
        return;
      }

      playingRef.current = true;
      setPlaying(true);
      setError("");
      setChapterIndex(startChapter);
      setParagraphIndex(startParagraph);
      posRef.current = { chapter: startChapter, paragraph: startParagraph };
      await persist(startChapter, startParagraph);

      let c = startChapter;
      let p = startParagraph;

      while (playingRef.current) {
        if (c >= book.chapters.length) {
          setStatus("全书朗读完成");
          stop();
          return;
        }

        const ch = book.chapters[c];
        if (p >= ch.paragraphs.length) {
          c += 1;
          p = 0;
          continue;
        }

        const text = ch.paragraphs[p];
        setChapterIndex(c);
        setParagraphIndex(p);
        posRef.current = { chapter: c, paragraph: p };
        await persist(c, p);

        // Scroll into view
        requestAnimationFrame(() => {
          document
            .getElementById(`para-${c}-${p}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        });

        setLoading(true);
        setStatus(`合成中 · ${ch.title} · 段 ${p + 1}/${ch.paragraphs.length}`);

        try {
          const buffer = await synthesizeSpeech(text, settings);
          if (!playingRef.current) return;

          cleanupAudio();
          const blob = new Blob([buffer], { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;

          const audio = new Audio(url);
          audioRef.current = audio;
          setLoading(false);
          setStatus(`朗读中 · ${ch.title}`);

          await new Promise<void>((resolve, reject) => {
            audio.onended = () => resolve();
            audio.onerror = () => reject(new Error("音频播放失败"));
            audio.play().catch(reject);
          });

          if (!playingRef.current) return;
          p += 1;
        } catch (e) {
          setError(e instanceof Error ? e.message : "朗读出错");
          stop();
          return;
        }
      }
    },
    [book.chapters, cleanupAudio, onOpenSettings, persist, settings, stop],
  );

  function handleToggle() {
    if (playing) {
      stop();
    } else {
      void playFrom(posRef.current.chapter, posRef.current.paragraph);
    }
  }

  function handleChapterChange(next: number) {
    stop();
    const idx = Math.max(0, Math.min(book.chapters.length - 1, next));
    setChapterIndex(idx);
    setParagraphIndex(0);
    posRef.current = { chapter: idx, paragraph: 0 };
    void persist(idx, 0);
  }

  function handleParagraphClick(pIndex: number) {
    stop();
    setParagraphIndex(pIndex);
    posRef.current = { chapter: chapterIndex, paragraph: pIndex };
    void persist(chapterIndex, pIndex);
  }

  return (
    <div className="reader">
      <header className="reader-bar">
        <button type="button" className="text-btn" onClick={onBack}>
          ← 书库
        </button>
        <div className="reader-title">
          <strong>{book.title}</strong>
          <span>{book.author}</span>
        </div>
        <button type="button" className="text-btn" onClick={onOpenSettings}>
          设置
        </button>
      </header>

      <div className="reader-toolbar">
        <select
          value={chapterIndex}
          onChange={(e) => handleChapterChange(Number(e.target.value))}
          aria-label="选择章节"
        >
          {book.chapters.map((ch, i) => (
            <option key={ch.id} value={i}>
              {i + 1}. {ch.title}
            </option>
          ))}
        </select>

        <div className="player-controls">
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              handleChapterChange(Math.max(0, chapterIndex - 1))
            }
            disabled={chapterIndex <= 0}
          >
            上一章
          </button>
          <button
            type="button"
            className="btn-primary play-btn"
            onClick={handleToggle}
            disabled={loading && !playing}
          >
            {playing ? (loading ? "合成中…" : "暂停") : "继续朗读"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              handleChapterChange(
                Math.min(book.chapters.length - 1, chapterIndex + 1),
              )
            }
            disabled={chapterIndex >= book.chapters.length - 1}
          >
            下一章
          </button>
        </div>
      </div>

      <p className="reader-status">
        {status}
        {initialProgress && !playing
          ? ` · 断点：第 ${chapterIndex + 1} 章 第 ${paragraphIndex + 1} 段`
          : ""}
      </p>
      {error && <p className="form-error">{error}</p>}

      <article className="reader-content">
        <h1>{chapter?.title}</h1>
        {chapter?.paragraphs.map((para, i) => (
          <p
            key={`${chapter.id}-${i}`}
            id={`para-${chapterIndex}-${i}`}
            className={
              i === paragraphIndex
                ? "paragraph is-active"
                : "paragraph"
            }
            onClick={() => handleParagraphClick(i)}
          >
            {para}
          </p>
        ))}
      </article>
    </div>
  );
}
