"use client";

import { useCallback, useRef, useState } from "react";
import type { AppSettings, ReadingProgress, StoredBook } from "@/lib/types";
import { saveProgress } from "@/lib/db";
import { synthesizeSpeech } from "@/lib/tts";
import {
  MobileAudioPlayer,
  normalizePlayError,
  type PreparedAudio,
} from "@/lib/audioPlayer";

interface ReaderProps {
  book: StoredBook;
  initialProgress?: ReadingProgress;
  settings: AppSettings;
  onOpenSettings: () => void;
  onBack: () => void;
}

type Pos = { chapter: number; paragraph: number };

function posKey(pos: Pos) {
  return `${pos.chapter}:${pos.paragraph}`;
}

function advancePos(
  chapters: StoredBook["chapters"],
  pos: Pos,
): Pos | null {
  let { chapter: c, paragraph: p } = pos;
  p += 1;
  while (c < chapters.length) {
    if (p < chapters[c].paragraphs.length) {
      return { chapter: c, paragraph: p };
    }
    c += 1;
    p = 0;
  }
  return null;
}

const PREFETCH_AHEAD = 2;

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

  const playerRef = useRef<MobileAudioPlayer | null>(null);
  const playingRef = useRef(false);
  const prefetchRef = useRef(new Map<string, Promise<PreparedAudio>>());
  const posRef = useRef({
    chapter: initialProgress?.chapterIndex ?? 0,
    paragraph: initialProgress?.paragraphIndex ?? 0,
  });

  const chapter = book.chapters[chapterIndex];

  const getPlayer = useCallback(() => {
    if (!playerRef.current) {
      playerRef.current = new MobileAudioPlayer();
    }
    return playerRef.current;
  }, []);

  const clearPrefetch = useCallback(() => {
    prefetchRef.current.clear();
  }, []);

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

  const stop = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    setLoading(false);
    setStatus("已暂停");
    playerRef.current?.stop();
    clearPrefetch();
  }, [clearPrefetch]);

  const ensurePrepared = useCallback(
    (pos: Pos, player: MobileAudioPlayer) => {
      const key = posKey(pos);
      const existing = prefetchRef.current.get(key);
      if (existing) return existing;

      const text = book.chapters[pos.chapter]?.paragraphs[pos.paragraph];
      if (!text) {
        return Promise.reject(new Error("段落不存在"));
      }

      const promise = synthesizeSpeech(text, settings)
        .then((buffer) => player.prepare(buffer))
        .catch((err) => {
          prefetchRef.current.delete(key);
          throw err;
        });

      prefetchRef.current.set(key, promise);
      return promise;
    },
    [book.chapters, settings],
  );

  const prefetchAhead = useCallback(
    (from: Pos, player: MobileAudioPlayer) => {
      let cursor: Pos | null = from;
      for (let i = 0; i < PREFETCH_AHEAD; i++) {
        cursor = advancePos(book.chapters, cursor);
        if (!cursor) break;
        void ensurePrepared(cursor, player);
      }
    },
    [book.chapters, ensurePrepared],
  );

  const playFrom = useCallback(
    async (startChapter: number, startParagraph: number) => {
      if (!settings.apiKey.trim()) {
        setError("请先在设置中填写 MiniMax Token Plan API Key");
        onOpenSettings();
        return;
      }

      const player = getPlayer();
      clearPrefetch();
      playingRef.current = true;
      setPlaying(true);
      setError("");
      setChapterIndex(startChapter);
      setParagraphIndex(startParagraph);
      posRef.current = { chapter: startChapter, paragraph: startParagraph };
      await persist(startChapter, startParagraph);

      let pos: Pos = { chapter: startChapter, paragraph: startParagraph };

      // Kick off first + lookahead immediately
      void ensurePrepared(pos, player);
      prefetchAhead(pos, player);

      while (playingRef.current) {
        if (pos.chapter >= book.chapters.length) {
          setStatus("全书朗读完成");
          stop();
          return;
        }

        const ch = book.chapters[pos.chapter];
        if (pos.paragraph >= ch.paragraphs.length) {
          const next = advancePos(book.chapters, {
            chapter: pos.chapter,
            paragraph: pos.paragraph - 1,
          });
          if (!next) {
            setStatus("全书朗读完成");
            stop();
            return;
          }
          pos = next;
          continue;
        }

        setChapterIndex(pos.chapter);
        setParagraphIndex(pos.paragraph);
        posRef.current = pos;
        await persist(pos.chapter, pos.paragraph);

        requestAnimationFrame(() => {
          document
            .getElementById(`para-${pos.chapter}-${pos.paragraph}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        });

        const key = posKey(pos);
        const pending = ensurePrepared(pos, player);
        // Only show "合成中" if audio is not ready yet
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await Promise.race([
          pending,
          new Promise<void>((r) => setTimeout(r, 80)),
        ]);
        if (!settled && playingRef.current) {
          setLoading(true);
          setStatus(
            `合成中 · ${ch.title} · 段 ${pos.paragraph + 1}/${ch.paragraphs.length}`,
          );
        }

        try {
          const prepared = await pending;
          if (!playingRef.current) return;

          prefetchRef.current.delete(key);
          prefetchAhead(pos, player);

          setLoading(false);
          setStatus(`朗读中 · ${ch.title}`);
          await player.playPrepared(prepared);

          if (!playingRef.current) return;
          const next = advancePos(book.chapters, pos);
          if (!next) {
            setStatus("全书朗读完成");
            stop();
            return;
          }
          pos = next;
        } catch (e) {
          setError(normalizePlayError(e).message);
          stop();
          return;
        }
      }
    },
    [
      book.chapters,
      clearPrefetch,
      ensurePrepared,
      getPlayer,
      onOpenSettings,
      persist,
      prefetchAhead,
      settings,
      stop,
    ],
  );

  function handleToggle() {
    if (playing) {
      stop();
      return;
    }
    // Critical for iOS: unlock audio inside the user gesture, before any await
    getPlayer().unlock();
    void playFrom(posRef.current.chapter, posRef.current.paragraph);
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
              i === paragraphIndex ? "paragraph is-active" : "paragraph"
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
