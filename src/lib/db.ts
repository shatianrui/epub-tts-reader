import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ReadingProgress, StoredBook } from "./types";

interface EpubReaderDB extends DBSchema {
  books: {
    key: string;
    value: StoredBook;
    indexes: { "by-updated": number };
  };
  progress: {
    key: string;
    value: ReadingProgress;
  };
}

const DB_NAME = "epub-tts-reader";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<EpubReaderDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<EpubReaderDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const books = db.createObjectStore("books", { keyPath: "id" });
        books.createIndex("by-updated", "updatedAt");
        db.createObjectStore("progress", { keyPath: "bookId" });
      },
    });
  }
  return dbPromise;
}

export async function listBooks(): Promise<StoredBook[]> {
  const db = await getDb();
  const books = await db.getAllFromIndex("books", "by-updated");
  return books.reverse();
}

export async function getBook(id: string): Promise<StoredBook | undefined> {
  const db = await getDb();
  return db.get("books", id);
}

export async function saveBook(book: StoredBook): Promise<void> {
  const db = await getDb();
  await db.put("books", book);
}

export async function deleteBook(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("books", id);
  await db.delete("progress", id);
}

export async function getProgress(
  bookId: string,
): Promise<ReadingProgress | undefined> {
  const db = await getDb();
  return db.get("progress", bookId);
}

export async function saveProgress(progress: ReadingProgress): Promise<void> {
  const db = await getDb();
  await db.put("progress", progress);
}
