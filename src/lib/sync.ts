"use client";

import { getSupabase } from "@/lib/supabase/client";
import type { AppSettings, ReadingProgress, StoredBook } from "@/lib/types";
import {
  listBooks,
  saveBook as saveBookLocal,
  deleteBook as deleteBookLocal,
  getProgress,
  saveProgress as saveProgressLocal,
} from "@/lib/db";
import { loadSettings, saveSettings as saveSettingsLocal } from "@/lib/settings";

export interface CloudBook {
  id: string;
  user_id: string;
  title: string;
  author: string;
  cover_data_url: string | null;
  file_name: string;
  epub_data: string;
  chapters: string;
  created_at: number;
  updated_at: number;
  cloud_updated_at: string;
}

export interface CloudProgress {
  book_id: string;
  user_id: string;
  chapter_index: number;
  paragraph_index: number;
  updated_at: number;
  cloud_updated_at: string;
}

export interface CloudSettings {
  user_id: string;
  settings: AppSettings;
  updated_at: number;
  cloud_updated_at: string;
}

export interface SyncResult {
  booksSynced: number;
  progressSynced: number;
  settingsSynced: boolean;
  errors: string[];
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function storedBookToCloud(book: StoredBook, userId: string): Omit<CloudBook, "cloud_updated_at"> {
  return {
    id: book.id,
    user_id: userId,
    title: book.title,
    author: book.author,
    cover_data_url: book.coverDataUrl ?? null,
    file_name: book.fileName,
    epub_data: arrayBufferToBase64(book.epubData),
    chapters: JSON.stringify(book.chapters),
    created_at: book.createdAt,
    updated_at: book.updatedAt,
  };
}

function cloudBookToStored(cloud: CloudBook): StoredBook {
  return {
    id: cloud.id,
    title: cloud.title,
    author: cloud.author,
    coverDataUrl: cloud.cover_data_url ?? undefined,
    fileName: cloud.file_name,
    epubData: base64ToArrayBuffer(cloud.epub_data),
    chapters: JSON.parse(cloud.chapters),
    createdAt: cloud.created_at,
    updatedAt: cloud.updated_at,
  };
}

function progressToCloud(
  progress: ReadingProgress,
  userId: string,
): Omit<CloudProgress, "cloud_updated_at"> {
  return {
    book_id: progress.bookId,
    user_id: userId,
    chapter_index: progress.chapterIndex,
    paragraph_index: progress.paragraphIndex,
    updated_at: progress.updatedAt,
  };
}

function cloudProgressToLocal(cloud: CloudProgress): ReadingProgress {
  return {
    bookId: cloud.book_id,
    chapterIndex: cloud.chapter_index,
    paragraphIndex: cloud.paragraph_index,
    updatedAt: cloud.updated_at,
  };
}

export async function isCloudEnabled(): Promise<boolean> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return false;
  }
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  return !!data.session;
}

export async function getCurrentUserId(): Promise<string | null> {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

export async function syncBooks(): Promise<{ synced: number; errors: string[] }> {
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

  const cloudBookMap = new Map((cloudBooks as CloudBook[]).map((b) => [b.id, b]));
  const localBookMap = new Map(localBooks.map((b) => [b.id, b]));

  let synced = 0;

  for (const localBook of localBooks) {
    const cloudBook = cloudBookMap.get(localBook.id);
    if (!cloudBook || localBook.updatedAt > cloudBook.updated_at) {
      const cloudData = storedBookToCloud(localBook, userId);
      const { error } = await supabase.from("books").upsert(cloudData, { onConflict: "id" });
      if (error) {
        errors.push(`同步书籍 "${localBook.title}" 失败: ${error.message}`);
      } else {
        synced++;
      }
    }
  }

  for (const cloudBook of cloudBooks as CloudBook[]) {
    if (!localBookMap.has(cloudBook.id)) {
      const localBook = cloudBookToStored(cloudBook);
      await saveBookLocal(localBook);
      synced++;
    }
  }

  return { synced, errors };
}

export async function syncProgress(): Promise<{ synced: number; errors: string[] }> {
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

  const cloudProgressMap = new Map(
    (cloudProgressList as CloudProgress[]).map((p) => [p.book_id, p]),
  );
  const localProgressMap = new Map(localProgressList.map((p) => [p.bookId, p]));

  let synced = 0;

  for (const localProgress of localProgressList) {
    const cloudProgress = cloudProgressMap.get(localProgress.bookId);
    if (!cloudProgress || localProgress.updatedAt > cloudProgress.updated_at) {
      const cloudData = progressToCloud(localProgress, userId);
      const { error } = await supabase
        .from("reading_progress")
        .upsert(cloudData, { onConflict: "book_id,user_id" });
      if (error) {
        errors.push(`同步进度失败 (${localProgress.bookId}): ${error.message}`);
      } else {
        synced++;
      }
    }
  }

  for (const cloudProgress of cloudProgressList as CloudProgress[]) {
    if (!localProgressMap.has(cloudProgress.book_id)) {
      const localProgress = cloudProgressToLocal(cloudProgress);
      await saveProgressLocal(localProgress);
      synced++;
    }
  }

  return { synced, errors };
}

export async function syncSettings(): Promise<{ synced: boolean; errors: string[] }> {
  const errors: string[] = [];
  const userId = await getCurrentUserId();
  if (!userId) return { synced: false, errors: ["用户未登录"] };

  const supabase = getSupabase();
  const localSettings = loadSettings();

  const { data: cloudSettingsData, error: fetchError } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (fetchError && fetchError.code !== "PGRST116") {
    errors.push(`获取云端设置失败: ${fetchError.message}`);
    return { synced: false, errors };
  }

  const cloudSettings = cloudSettingsData as CloudSettings | null;
  const localUpdatedAt = Date.now();

  if (!cloudSettings) {
    const { error } = await supabase.from("user_settings").insert({
      user_id: userId,
      settings: localSettings,
      updated_at: localUpdatedAt,
    });
    if (error) {
      errors.push(`同步设置失败: ${error.message}`);
      return { synced: false, errors };
    }
    return { synced: true, errors };
  }

  if (cloudSettings.updated_at < localUpdatedAt) {
    const { error } = await supabase
      .from("user_settings")
      .update({
        settings: localSettings,
        updated_at: localUpdatedAt,
      })
      .eq("user_id", userId);
    if (error) {
      errors.push(`同步设置失败: ${error.message}`);
      return { synced: false, errors };
    }
    return { synced: true, errors };
  } else if (cloudSettings.updated_at > localUpdatedAt) {
    saveSettingsLocal(cloudSettings.settings);
    return { synced: true, errors };
  }

  return { synced: false, errors };
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
    errors.push(`同步书籍时出错: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const progressResult = await syncProgress();
    progressSynced = progressResult.synced;
    errors.push(...progressResult.errors);
  } catch (e) {
    errors.push(`同步进度时出错: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const settingsResult = await syncSettings();
    settingsSynced = settingsResult.synced;
    errors.push(...settingsResult.errors);
  } catch (e) {
    errors.push(`同步设置时出错: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { booksSynced, progressSynced, settingsSynced, errors };
}

export async function uploadBook(book: StoredBook): Promise<{ error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { error: "用户未登录" };

  const supabase = getSupabase();
  const cloudData = storedBookToCloud(book, userId);

  const { error } = await supabase.from("books").upsert(cloudData, { onConflict: "id" });
  if (error) return { error: error.message };
  return {};
}

export async function removeBookFromCloud(bookId: string): Promise<{ error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { error: "用户未登录" };

  const supabase = getSupabase();

  const { error: progressError } = await supabase
    .from("reading_progress")
    .delete()
    .eq("book_id", bookId)
    .eq("user_id", userId);

  if (progressError) return { error: progressError.message };

  const { error } = await supabase
    .from("books")
    .delete()
    .eq("id", bookId)
    .eq("user_id", userId);

  if (error) return { error: error.message };
  return {};
}

export async function uploadProgress(progress: ReadingProgress): Promise<{ error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { error: "用户未登录" };

  const supabase = getSupabase();
  const cloudData = progressToCloud(progress, userId);

  const { error } = await supabase
    .from("reading_progress")
    .upsert(cloudData, { onConflict: "book_id,user_id" });

  if (error) return { error: error.message };
  return {};
}

export async function uploadSettings(settings: AppSettings): Promise<{ error?: string }> {
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
