"use client";

import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import type { AppSettings, ReadingProgress, StoredBook } from "@/lib/types";
import {
  listBooks,
  saveBook as saveBookLocal,
  getProgress,
  saveProgress as saveProgressLocal,
} from "@/lib/db";
import { loadSettings, saveSettings as saveSettingsLocal, getSettingsUpdatedAt } from "@/lib/settings";
import { parseEpub } from "@/lib/epub";

const BUCKET = "epubs";

export interface CloudBookMeta {
  id: string;
  user_id: string;
  title: string;
  author: string;
  cover_data_url: string | null;
  file_name: string;
  created_at: number;
  updated_at: number;
}

export interface CloudProgress {
  book_id: string;
  user_id: string;
  chapter_index: number;
  paragraph_index: number;
  updated_at: number;
}

export interface CloudSettings {
  user_id: string;
  settings: AppSettings;
  updated_at: number;
}

export interface SyncResult {
  booksSynced: number;
  progressSynced: number;
  settingsSynced: boolean;
  errors: string[];
}

function epubPath(userId: string, bookId: string) {
  return `${userId}/${bookId}.epub`;
}

export async function getCurrentUserId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

export async function isCloudEnabled(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  return Boolean(await getCurrentUserId());
}

async function uploadEpubFile(
  userId: string,
  book: StoredBook,
): Promise<{ error?: string }> {
  const supabase = getSupabase();
  const path = epubPath(userId, book.id);
  const blob = new Blob([book.epubData], { type: "application/epub+zip" });

  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    upsert: true,
    contentType: "application/epub+zip",
  });

  if (error) return { error: error.message };
  return {};
}

async function downloadEpubFile(
  userId: string,
  bookId: string,
): Promise<ArrayBuffer> {
  const supabase = getSupabase();
  const path = epubPath(userId, bookId);
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new Error(error?.message || "下载 EPUB 失败");
  }
  return data.arrayBuffer();
}

export async function uploadBook(
  book: StoredBook,
): Promise<{ error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { error: "用户未登录" };

  const fileResult = await uploadEpubFile(userId, book);
  if (fileResult.error) return fileResult;

  const supabase = getSupabase();
  const { error } = await supabase.from("books").upsert(
    {
      id: book.id,
      user_id: userId,
      title: book.title,
      author: book.author,
      cover_data_url: book.coverDataUrl ?? null,
      file_name: book.fileName,
      created_at: book.createdAt,
      updated_at: book.updatedAt,
    },
    { onConflict: "id" },
  );

  if (error) return { error: error.message };
  return {};
}

export async function removeBookFromCloud(
  bookId: string,
): Promise<{ error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { error: "用户未登录" };

  const supabase = getSupabase();

  await supabase
    .from("reading_progress")
    .delete()
    .eq("book_id", bookId)
    .eq("user_id", userId);

  const { error: metaError } = await supabase
    .from("books")
    .delete()
    .eq("id", bookId)
    .eq("user_id", userId);

  if (metaError) return { error: metaError.message };

  const { error: storageError } = await supabase.storage
    .from(BUCKET)
    .remove([epubPath(userId, bookId)]);

  if (storageError) return { error: storageError.message };
  return {};
}

export async function pushProgress(
  progress: ReadingProgress,
): Promise<{ error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { error: "用户未登录" };

  const supabase = getSupabase();
  const { error } = await supabase.from("reading_progress").upsert(
    {
      book_id: progress.bookId,
      user_id: userId,
      chapter_index: progress.chapterIndex,
      paragraph_index: progress.paragraphIndex,
      updated_at: progress.updatedAt,
    },
    { onConflict: "book_id,user_id" },
  );

  if (error) return { error: error.message };
  return {};
}

/** @deprecated use pushProgress */
export const uploadProgress = pushProgress;

export async function pushSettings(
  settings: AppSettings,
): Promise<{ error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { error: "用户未登录" };

  const supabase = getSupabase();
  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: userId,
      settings,
      updated_at: Date.now(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { error: error.message };
  return {};
}

/** @deprecated use pushSettings */
export const uploadSettings = pushSettings;

async function pullMissingBook(
  userId: string,
  meta: CloudBookMeta,
): Promise<void> {
  const epubData = await downloadEpubFile(userId, meta.id);
  const parsed = await parseEpub(epubData);
  const book: StoredBook = {
    id: meta.id,
    title: meta.title || parsed.title,
    author: meta.author || parsed.author,
    coverDataUrl: meta.cover_data_url ?? parsed.coverDataUrl,
    fileName: meta.file_name,
    epubData,
    chapters: parsed.chapters,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
  };
  await saveBookLocal(book);
}

export async function syncBooks(): Promise<{
  synced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const userId = await getCurrentUserId();
  if (!userId) return { synced: 0, errors: ["用户未登录"] };

  const supabase = getSupabase();
  const localBooks = await listBooks();

  const { data: cloudBooks, error: fetchError } = await supabase
    .from("books")
    .select("*")
    .eq("user_id", userId);

  if (fetchError) {
    errors.push(`获取云端书籍失败: ${fetchError.message}`);
    return { synced: 0, errors };
  }

  const cloudList = (cloudBooks ?? []) as CloudBookMeta[];
  const cloudMap = new Map(cloudList.map((b) => [b.id, b]));
  const localMap = new Map(localBooks.map((b) => [b.id, b]));

  let synced = 0;

  // Push local books that are newer or missing remotely
  for (const localBook of localBooks) {
    const cloud = cloudMap.get(localBook.id);
    if (!cloud || localBook.updatedAt > cloud.updated_at) {
      const result = await uploadBook(localBook);
      if (result.error) {
        errors.push(`同步书籍「${localBook.title}」失败: ${result.error}`);
      } else {
        synced++;
      }
    }
  }

  // Pull remote books missing locally
  for (const cloud of cloudList) {
    if (!localMap.has(cloud.id)) {
      try {
        await pullMissingBook(userId, cloud);
        synced++;
      } catch (e) {
        errors.push(
          `拉取书籍「${cloud.title}」失败: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }

  return { synced, errors };
}

export async function syncProgress(): Promise<{
  synced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const userId = await getCurrentUserId();
  if (!userId) return { synced: 0, errors: ["用户未登录"] };

  const supabase = getSupabase();
  const localBooks = await listBooks();

  const localProgressList: ReadingProgress[] = [];
  for (const book of localBooks) {
    const p = await getProgress(book.id);
    if (p) localProgressList.push(p);
  }

  const { data: cloudProgressList, error: fetchError } = await supabase
    .from("reading_progress")
    .select("*")
    .eq("user_id", userId);

  if (fetchError) {
    errors.push(`获取云端进度失败: ${fetchError.message}`);
    return { synced: 0, errors };
  }

  const cloudList = (cloudProgressList ?? []) as CloudProgress[];
  const cloudMap = new Map(cloudList.map((p) => [p.book_id, p]));
  const localMap = new Map(localProgressList.map((p) => [p.bookId, p]));

  let synced = 0;

  for (const local of localProgressList) {
    const cloud = cloudMap.get(local.bookId);
    if (!cloud || local.updatedAt > cloud.updated_at) {
      const result = await pushProgress(local);
      if (result.error) {
        errors.push(`同步进度失败: ${result.error}`);
      } else {
        synced++;
      }
    }
  }

  for (const cloud of cloudList) {
    const local = localMap.get(cloud.book_id);
    if (!local || cloud.updated_at > local.updatedAt) {
      await saveProgressLocal({
        bookId: cloud.book_id,
        chapterIndex: cloud.chapter_index,
        paragraphIndex: cloud.paragraph_index,
        updatedAt: cloud.updated_at,
      });
      synced++;
    }
  }

  return { synced, errors };
}

export async function syncSettings(): Promise<{
  synced: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  const userId = await getCurrentUserId();
  if (!userId) return { synced: false, errors: ["用户未登录"] };

  const supabase = getSupabase();
  const localSettings = loadSettings();
  const localStamp = getSettingsUpdatedAt();

  const { data: cloudSettingsData, error: fetchError } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchError) {
    errors.push(`获取云端设置失败: ${fetchError.message}`);
    return { synced: false, errors };
  }

  const cloud = cloudSettingsData as CloudSettings | null;

  if (!cloud) {
    const result = await pushSettings(localSettings);
    if (result.error) {
      errors.push(`同步设置失败: ${result.error}`);
      return { synced: false, errors };
    }
    return { synced: true, errors };
  }

  if (localStamp >= cloud.updated_at) {
    const result = await pushSettings(localSettings);
    if (result.error) {
      errors.push(`同步设置失败: ${result.error}`);
      return { synced: false, errors };
    }
    return { synced: true, errors };
  }

  saveSettingsLocal(cloud.settings);
  return { synced: true, errors };
}

export async function syncAll(): Promise<SyncResult> {
  const errors: string[] = [];
  let booksSynced = 0;
  let progressSynced = 0;
  let settingsSynced = false;

  try {
    const booksResult = await syncBooks();
    booksSynced = booksResult.synced;
    errors.push(...booksResult.errors);
  } catch (e) {
    errors.push(
      `同步书籍时出错: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const progressResult = await syncProgress();
    progressSynced = progressResult.synced;
    errors.push(...progressResult.errors);
  } catch (e) {
    errors.push(
      `同步进度时出错: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const settingsResult = await syncSettings();
    settingsSynced = settingsResult.synced;
    errors.push(...settingsResult.errors);
  } catch (e) {
    errors.push(
      `同步设置时出错: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { booksSynced, progressSynced, settingsSynced, errors };
}

/** pullAll alias used by plan naming */
export const pullAll = syncAll;
