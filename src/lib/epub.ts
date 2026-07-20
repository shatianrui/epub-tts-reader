import JSZip from "jszip";
import type { BookChapter } from "./types";

function extractParagraphs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript").forEach((el) => el.remove());

  const blocks = Array.from(
    doc.body?.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote") ??
      [],
  );

  let paragraphs = blocks
    .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);

  if (paragraphs.length === 0) {
    const raw = (doc.body?.textContent || "")
      .replace(/\r/g, "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    paragraphs = raw;
  }

  // Merge tiny fragments for smoother TTS
  const merged: string[] = [];
  let buffer = "";
  for (const p of paragraphs) {
    if (buffer && buffer.length + p.length < 80) {
      buffer = `${buffer}${/[。！？.!?]/.test(buffer.slice(-1)) ? "" : "，"}${p}`;
    } else {
      if (buffer) merged.push(buffer);
      buffer = p;
    }
  }
  if (buffer) merged.push(buffer);

  return merged.filter((p) => p.length > 0);
}

function resolvePath(base: string, relative: string): string {
  if (!relative) return base;
  if (/^(https?:|data:)/i.test(relative)) return relative;
  const clean = relative.split("#")[0].split("?")[0];
  const baseParts = base.split("/").filter(Boolean);
  if (base && !base.endsWith("/")) baseParts.pop();
  const relParts = clean.split("/");
  for (const part of relParts) {
    if (part === "." || part === "") continue;
    if (part === "..") baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join("/");
}

function findZipFile(zip: JSZip, path: string) {
  const normalized = path.replace(/^\.\//, "").replace(/^\/+/, "");
  const direct = zip.file(normalized);
  if (direct) return direct;
  const lower = normalized.toLowerCase();
  const match = Object.keys(zip.files).find(
    (k) => k.replace(/\\/g, "/").toLowerCase() === lower,
  );
  return match ? zip.file(match) : null;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export interface ParsedEpub {
  title: string;
  author: string;
  coverDataUrl?: string;
  chapters: BookChapter[];
}

export async function parseEpub(data: ArrayBuffer): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(data);
  const containerFile = findZipFile(zip, "META-INF/container.xml");
  if (!containerFile) throw new Error("无效的 EPUB：缺少 container.xml");

  const containerXml = await containerFile.async("text");
  const containerDoc = new DOMParser().parseFromString(
    containerXml,
    "application/xml",
  );
  const rootfile = containerDoc
    .getElementsByTagName("rootfile")[0]
    ?.getAttribute("full-path");
  if (!rootfile) throw new Error("无效的 EPUB：无法定位内容清单");

  const opfFile = findZipFile(zip, rootfile);
  if (!opfFile) throw new Error("无效的 EPUB：找不到 OPF 文件");

  const opfXml = await opfFile.async("text");
  const opfDoc = new DOMParser().parseFromString(opfXml, "application/xml");
  const opfDir = rootfile.includes("/")
    ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1)
    : "";

  const getMeta = (name: string) => {
    const nodes = Array.from(opfDoc.getElementsByTagName(name));
    return nodes[0]?.textContent?.trim() || "";
  };

  const title =
    getMeta("dc:title") ||
    getMeta("title") ||
    "未命名书籍";
  const author =
    getMeta("dc:creator") ||
    getMeta("creator") ||
    "未知作者";

  const manifest = new Map<
    string,
    { href: string; mediaType: string; properties?: string }
  >();
  for (const item of Array.from(opfDoc.getElementsByTagName("item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type") || "";
    const properties = item.getAttribute("properties") || undefined;
    if (id && href) {
      manifest.set(id, { href, mediaType, properties });
    }
  }

  const spineIds = Array.from(opfDoc.getElementsByTagName("itemref"))
    .map((el) => el.getAttribute("idref"))
    .filter((id): id is string => Boolean(id));

  // Cover
  let coverDataUrl: string | undefined;
  const coverMeta = Array.from(opfDoc.getElementsByTagName("meta")).find(
    (m) => m.getAttribute("name") === "cover",
  );
  const coverId =
    coverMeta?.getAttribute("content") ||
    Array.from(manifest.entries()).find(([, v]) =>
      (v.properties || "").includes("cover-image"),
    )?.[0];

  if (coverId && manifest.has(coverId)) {
    const coverPath = resolvePath(opfDir, manifest.get(coverId)!.href);
    const coverFile = findZipFile(zip, coverPath);
    if (coverFile) {
      const blob = await coverFile.async("blob");
      coverDataUrl = await blobToDataUrl(blob);
    }
  }

  // NCX / nav titles
  const titleByHref = new Map<string, string>();
  const ncxItem = Array.from(manifest.values()).find(
    (v) =>
      v.mediaType === "application/x-dtbncx+xml" ||
      v.href.toLowerCase().endsWith(".ncx"),
  );
  if (ncxItem) {
    const ncxPath = resolvePath(opfDir, ncxItem.href);
    const ncxFile = findZipFile(zip, ncxPath);
    if (ncxFile) {
      const ncxXml = await ncxFile.async("text");
      const ncxDoc = new DOMParser().parseFromString(ncxXml, "application/xml");
      for (const navPoint of Array.from(
        ncxDoc.getElementsByTagName("navPoint"),
      )) {
        const label =
          navPoint.getElementsByTagName("text")[0]?.textContent?.trim() || "";
        const src =
          navPoint.getElementsByTagName("content")[0]?.getAttribute("src") ||
          "";
        if (label && src) {
          const href = resolvePath(
            ncxPath.includes("/")
              ? ncxPath.slice(0, ncxPath.lastIndexOf("/") + 1)
              : "",
            src.split("#")[0],
          );
          titleByHref.set(href, label);
        }
      }
    }
  }

  const chapters: BookChapter[] = [];
  for (let i = 0; i < spineIds.length; i++) {
    const item = manifest.get(spineIds[i]);
    if (!item) continue;
    if (!/html|xml|xhtml/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) {
      continue;
    }

    const href = resolvePath(opfDir, item.href);
    const file = findZipFile(zip, href);
    if (!file) continue;

    const html = await file.async("text");
    const paragraphs = extractParagraphs(html);
    if (paragraphs.length === 0) continue;

    const chapterTitle =
      titleByHref.get(href) ||
      paragraphs.find((p) => p.length < 40)?.slice(0, 40) ||
      `第 ${chapters.length + 1} 章`;

    chapters.push({
      id: spineIds[i],
      href,
      title: chapterTitle,
      paragraphs,
    });
  }

  if (chapters.length === 0) {
    throw new Error("未能从 EPUB 中提取可读文本");
  }

  return {
    title,
    author,
    coverDataUrl,
    chapters,
  };
}
