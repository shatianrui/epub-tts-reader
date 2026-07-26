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
  type TimelineSegment,
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

/** Prefetch depth — higher so background batches are already synthesized. */
const PREFETCH_AHEAD = 6;
/** Paragraphs scheduled onto the audio clock in one shot (iOS background). */
const PLAY_BATCH_FOREGROUND = 3;
const PLAY_BATCH_BACKGROUND = 6;

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

      player.stop();
      clearPrefetch();
      playingRef.current = true;
      setPlaying(true);
      setError("");
      setMediaSessionPlaybackState("playing");
      setChapterIndex(startChapter);
      setParagraphIndex(startParagraph);
      posRef.current = { chapter: startChapter, paragraph: startParagraph };
      void persist(startChapter, startParagraph);

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

        const batchSize =
          typeof document !== "undefined" &&
          document.visibilityState === "hidden"
            ? PLAY_BATCH_BACKGROUND
            : PLAY_BATCH_FOREGROUND;

        // Build a multi-paragraph window and schedule it on the audio clock
        // in one shot — survives iOS background JS throttling.
        type BatchItem = { pos: Pos; prepared: PreparedAudio; gapAfterMs: number };
        const batch: BatchItem[] = [];
        let cursor: Pos | null = pos;
        let stopAfterChapter = false;

        while (cursor && batch.length < batchSize && stillActive()) {
          const ch = book.chapters[cursor.chapter];
          if (!ch || cursor.paragraph >= ch.paragraphs.length) {
            cursor = advancePos(book.chapters, {
              chapter: cursor.chapter,
              paragraph: Math.max(0, (ch?.paragraphs.length || 1) - 1),
            });
            continue;
          }

          const key = posKey(cursor);
          if (batch.length === 0) {
            let isReady = false;
            const pending = ensurePrepared(cursor, player);
            void pending.then(() => {
              isReady = true;
            });
            await new Promise<void>((r) => setTimeout(r, 30));
            if (!isReady && stillActive()) {
              setLoading(true);
              setStatus(
                `合成中 · ${ch.title} · 段 ${cursor.paragraph + 1}/${ch.paragraphs.length}`,
              );
            }
          }

          try {
            const prepared = await ensurePrepared(cursor, player);
            if (!stillActive()) return;
            prefetchRef.current.delete(key);

            const next = advancePos(book.chapters, cursor);
            let gapAfterMs = Math.max(
              0,
              (settings.paragraphInterval ?? 0.05) * 1000,
            );

            if (!next) {
              gapAfterMs = 0;
            } else if (next.chapter !== cursor.chapter) {
              if (!settings.autoNextChapter) {
                gapAfterMs = 0;
                stopAfterChapter = true;
              } else if (settings.chapterGap > 0) {
                gapAfterMs = Math.max(gapAfterMs, settings.chapterGap * 1000);
              }
            }

            batch.push({ pos: cursor, prepared, gapAfterMs });
            prefetchAhead(cursor, player);

            if (stopAfterChapter || !next) {
              cursor = next;
              break;
            }
            cursor = next;
          } catch (e) {
            if (!stillActive()) return;
            if (batch.length === 0) {
              setError(normalizePlayError(e).message);
              stop();
              return;
            }
            break;
          }
        }

        if (!stillActive()) return;
        if (batch.length === 0) {
          setStatus("全书朗读完成");
          stop();
          return;
        }

        const first = batch[0];
        const firstCh = book.chapters[first.pos.chapter];
        setChapterIndex(first.pos.chapter);
        setParagraphIndex(first.pos.paragraph);
        posRef.current = first.pos;
        void persist(first.pos.chapter, first.pos.paragraph);

        setMediaSession(
          {
            title: firstCh?.title || book.title,
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
        setLoading(false);
        setStatus(`朗读中 · ${firstCh?.title || book.title}`);

        if (
          typeof document !== "undefined" &&
          document.visibilityState === "visible"
        ) {
          requestAnimationFrame(() => {
            document
              .getElementById(
                `para-${first.pos.chapter}-${first.pos.paragraph}`,
              )
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          });
        }

        const segments: TimelineSegment[] = batch.map((b) => ({
          prepared: b.prepared,
          gapAfterMs: b.gapAfterMs,
        }));

        try {
          await player.playWindow(segments, {
            onSegmentStart: (index) => {
              if (!stillActive()) return;
              const item = batch[index];
              if (!item) return;
              setChapterIndex(item.pos.chapter);
              setParagraphIndex(item.pos.paragraph);
              posRef.current = item.pos;
              void persist(item.pos.chapter, item.pos.paragraph);
              const title = book.chapters[item.pos.chapter]?.title;
              if (title) setStatus(`朗读中 · ${title}`);
              if (
                typeof document !== "undefined" &&
                document.visibilityState === "visible"
              ) {
                document
                  .getElementById(
                    `para-${item.pos.chapter}-${item.pos.paragraph}`,
                  )
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            },
          });
        } catch (e) {
          if (!stillActive()) return;
          setError(normalizePlayError(e).message);
          stop();
          return;
        }

        if (!stillActive()) return;

        const last = batch[batch.length - 1];
        if (stopAfterChapter) {
          setStatus(
            `${book.chapters[last.pos.chapter]?.title || ""} 朗读完成，点击继续下一章`,
          );
          stop();
          return;
        }

        const nextPos = advancePos(book.chapters, last.pos);
        if (!nextPos) {
          setStatus("全书朗读完成");
          stop();
          return;
        }
        pos = nextPos;
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
