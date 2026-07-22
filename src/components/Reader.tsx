"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, ReadingProgress, StoredBook } from "@/lib/types";
import { saveProgress } from "@/lib/db";
import { activeApiKeyConfigured, synthesizeSpeech } from "@/lib/tts";
import { useAuth } from "@/lib/auth";
import { pushProgress } from "@/lib/sync";
import {
  MobileAudioPlayer,
  normalizePlayError,
  setMediaSession,
  setMediaSessionPlaybackState,
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
  const { user } = useAuth();
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
  /** Bumps on every stop/start so stale playFrom loops exit cleanly. */
  const sessionRef = useRef(0);
  const playFromRef = useRef<
    ((startChapter: number, startParagraph: number) => Promise<void>) | null
  >(null);
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

  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    async (c: number, p: number) => {
      const progress = {
        bookId: book.id,
        chapterIndex: c,
        paragraphIndex: p,
        updatedAt: Date.now(),
      };
      await saveProgress(progress);
      if (user) {
        if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
        progressTimerRef.current = setTimeout(() => {
          void pushProgress(progress);
        }, 800);
      }
    },
    [book.id, user],
  );

  const stop = useCallback(() => {
    sessionRef.current += 1;
    playingRef.current = false;
    setPlaying(false);
    setLoading(false);
    setStatus("已暂停");
    setMediaSessionPlaybackState("paused");
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
        .then((speech) => player.prepare(speech))
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
      if (!activeApiKeyConfigured(settings)) {
        setError(
          settings.ttsProvider === "grok"
            ? "请先在设置中填写 Grok / xAI API Key"
            : "请先在设置中填写 MiniMax Token Plan API Key",
        );
        onOpenSettings();
        return;
      }

      const player = getPlayer();
      // Invalidate any previous loop, then claim a fresh session
      sessionRef.current += 1;
      const session = sessionRef.current;
      const stillActive = () =>
        playingRef.current && sessionRef.current === session;

      clearPrefetch();
      playingRef.current = true;
      setPlaying(true);
      setError("");
      setMediaSessionPlaybackState("playing");
      setChapterIndex(startChapter);
      setParagraphIndex(startParagraph);
      posRef.current = { chapter: startChapter, paragraph: startParagraph };
      await persist(startChapter, startParagraph);
      if (!stillActive()) return;

      let pos: Pos = { chapter: startChapter, paragraph: startParagraph };

      // Kick off first + lookahead immediately
      void ensurePrepared(pos, player);
      prefetchAhead(pos, player);

      while (stillActive()) {
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
        if (!stillActive()) return;

        setMediaSession(
          {
            title: ch.title,
            artist: book.author || book.title,
            album: book.title,
          },
          {
            play: () => {
              if (!playingRef.current) {
                getPlayer().unlock();
                void playFromRef.current?.(
                  posRef.current.chapter,
                  posRef.current.paragraph,
                );
              }
            },
            pause: () => {
              if (playingRef.current) stop();
            },
          },
        );
        setMediaSessionPlaybackState("playing");

        // Scroll only when visible — rAF is throttled in background tabs
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "visible"
        ) {
          requestAnimationFrame(() => {
            document
              .getElementById(`para-${pos.chapter}-${pos.paragraph}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          });
        }

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
        if (!settled && stillActive()) {
          setLoading(true);
          setStatus(
            `合成中 · ${ch.title} · 段 ${pos.paragraph + 1}/${ch.paragraphs.length}`,
          );
        }

        try {
          const prepared = await pending;
          if (!stillActive()) return;

          prefetchRef.current.delete(key);
          prefetchAhead(pos, player);

          setLoading(false);
          setStatus(`朗读中 · ${ch.title}`);
          await player.playPrepared(prepared);

          if (!stillActive()) return;

          // Brief breath between paragraphs so the last syllables are never
          // overlapped by the next clip starting immediately.
          await new Promise<void>((r) => setTimeout(r, 180));
          if (!stillActive()) return;

          const next = advancePos(book.chapters, pos);
          if (!next) {
            setStatus("全书朗读完成");
            stop();
            return;
          }

          const isNewChapter = next.chapter !== pos.chapter;
          if (isNewChapter) {
            if (!settings.autoNextChapter) {
              setStatus(`${ch.title} 朗读完成，点击继续下一章`);
              stop();
              return;
            }
            if (settings.chapterGap > 0) {
              setStatus(`第 ${next.chapter + 1} 章即将开始…`);
              await new Promise<void>((r) =>
                setTimeout(r, settings.chapterGap * 1000),
              );
              if (!stillActive()) return;
            }
          }

          pos = next;
        } catch (e) {
          if (!stillActive()) return;
          setError(normalizePlayError(e).message);
          stop();
          return;
        }
      }
    },
    [
      book.author,
      book.chapters,
      book.title,
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

  const startPlayback = useCallback(
    (chapter: number, paragraph: number) => {
      // Critical for iOS: unlock audio inside the user gesture, before any await
      getPlayer().unlock();
      void playFrom(chapter, paragraph);
    },
    [getPlayer, playFrom],
  );

  useEffect(() => {
    playFromRef.current = playFrom;
  }, [playFrom]);

  function handleToggle() {
    if (playing) {
      stop();
      return;
    }
    startPlayback(posRef.current.chapter, posRef.current.paragraph);
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
    // Click active (highlighted) paragraph → pause / resume
    if (pIndex === paragraphIndex) {
      handleToggle();
      return;
    }

    // Click another paragraph → jump here and start reading
    if (playing) {
      // Invalidate current session without flipping UI to "已暂停"
      sessionRef.current += 1;
      playingRef.current = false;
      playerRef.current?.stop();
      clearPrefetch();
    }
    posRef.current = { chapter: chapterIndex, paragraph: pIndex };
    setParagraphIndex(pIndex);
    void persist(chapterIndex, pIndex);
    startPlayback(chapterIndex, pIndex);
  }

  // Keep media session in sync; HTMLAudioElement continues in background.
  useEffect(() => {
    setMediaSession(
      {
        title: chapter?.title || book.title,
        artist: book.author || book.title,
        album: book.title,
      },
      {
        play: () => {
          if (!playingRef.current) {
            getPlayer().unlock();
            void playFromRef.current?.(
              posRef.current.chapter,
              posRef.current.paragraph,
            );
          }
        },
        pause: () => {
          if (playingRef.current) stop();
        },
      },
    );
  }, [book.author, book.title, chapter?.title, getPlayer, stop]);

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      playingRef.current = false;
      playerRef.current?.stop();
      setMediaSessionPlaybackState("none");
    };
  }, []);

  useEffect(() => {
    function handleBeforeUnload() {
      const pos = posRef.current;
      void persist(pos.chapter, pos.paragraph);
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handleBeforeUnload);
    };
  }, [persist]);

  const playLabel = playing ? (loading ? "合成中" : "暂停") : "播放";

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
        <div className="reader-bar-actions">
          <button
            type="button"
            className="btn-play-compact"
            onClick={handleToggle}
            disabled={loading && !playing}
            aria-label={playLabel}
          >
            {playing ? (loading ? "…" : "⏸") : "▶"}
          </button>
          <button type="button" className="text-btn" onClick={onOpenSettings}>
            设置
          </button>
        </div>
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

        <div className="player-controls desktop-only">
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
        {chapter?.paragraphs.map((para, i) => {
          const active = i === paragraphIndex;
          return (
            <div
              key={`${chapter.id}-${i}`}
              id={`para-${chapterIndex}-${i}`}
              className={
                active ? "paragraph-row is-active" : "paragraph-row"
              }
            >
              <p
                className="paragraph"
                onClick={() => handleParagraphClick(i)}
                title={
                  active
                    ? playing
                      ? "点击暂停"
                      : "点击继续朗读"
                    : "点击从此段开始朗读"
                }
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleParagraphClick(i);
                  }
                }}
                aria-pressed={active ? playing : undefined}
                aria-label={
                  active
                    ? playing
                      ? "当前段落，点击暂停"
                      : "当前段落，点击继续朗读"
                    : `第 ${i + 1} 段，点击从此处朗读`
                }
              >
                {para}
              </p>
              {active && (
                <button
                  type="button"
                  className="para-play-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggle();
                  }}
                  aria-label={playLabel}
                >
                  {playing ? (loading ? "…" : "⏸") : "▶"}
                </button>
              )}
            </div>
          );
        })}
      </article>

      <div className="reader-dock" role="toolbar" aria-label="播放控制">
        <button
          type="button"
          className="dock-btn"
          onClick={() => handleChapterChange(Math.max(0, chapterIndex - 1))}
          disabled={chapterIndex <= 0}
        >
          上一章
        </button>
        <button
          type="button"
          className={`dock-play ${playing ? "is-playing" : ""}`}
          onClick={handleToggle}
          disabled={loading && !playing}
          aria-label={playLabel}
        >
          <span className="dock-play-icon">
            {playing ? (loading ? "…" : "⏸") : "▶"}
          </span>
          <span className="dock-play-text">
            {playing ? (loading ? "合成中" : "暂停") : "播放"}
          </span>
        </button>
        <button
          type="button"
          className="dock-btn"
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
  );
}
