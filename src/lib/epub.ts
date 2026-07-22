import JSZip from "jszip";
import type { BookChapter } from "./types";

interface NavEntry {
  href: string;
  fragment?: string;
  title: string;
  order: number;
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizePathKey(path: string): string {
  return decodePath(path)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("#")[0]
    .split("?")[0]
    .toLowerCase();
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

function splitHref(href: string): { path: string; fragment?: string } {
  const [path, fragment] = href.split("#");
  return {
    path: path || "",
    fragment: fragment || undefined,
  };
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

function mergeTinyParagraphs(paragraphs: string[]): string[] {
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

function textFromElement(el: Element): string {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

function isBlockContainer(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return /^(p|h[1-6]|li|blockquote|div|section|article|td|th|pre|figcaption)$/.test(
    tag,
  );
}

function hasNestedBlockWithText(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (!isBlockContainer(child)) continue;
    if (textFromElement(child).length > 0) return true;
  }
  return false;
}

function extractParagraphsFromDocument(doc: Document): string[] {
  doc.querySelectorAll("script, style, noscript").forEach((el) => el.remove());

  const blockSelector =
    "p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article, pre, td, th";
  const blocks = Array.from(doc.body?.querySelectorAll(blockSelector) ?? []);

  let paragraphs = blocks
    .filter((el) => {
      if (!textFromElement(el)) return false;
      if (hasNestedBlockWithText(el)) return false;
      return true;
    })
    .map((el) => textFromElement(el))
    .filter((t) => t.length > 0);

  if (paragraphs.length === 0) {
    const raw = (doc.body?.textContent || "")
      .replace(/\r/g, "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    paragraphs = raw;
  }

  if (paragraphs.length === 0) {
    const brSplit = (doc.body?.innerHTML || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n");
    const temp = new DOMParser().parseFromString(brSplit, "text/html");
    const raw = (temp.body?.textContent || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0);
    paragraphs = raw;
  }

  return mergeTinyParagraphs(paragraphs);
}

function extractParagraphs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return extractParagraphsFromDocument(doc);
}

function findAnchorElement(doc: Document, fragment?: string): Element | null {
  if (!fragment) return doc.body;
  const decoded = decodePath(fragment);
  const byId = doc.getElementById(decoded);
  if (byId) return byId;
  const byName = doc.querySelector(`[name="${CSS.escape(decoded)}"]`);
  if (byName) return byName;
  return doc.body?.querySelector(`#${CSS.escape(decoded)}`) ?? null;
}

function sliceHtmlByAnchors(
  html: string,
  startFragment?: string,
  endFragment?: string,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return html;

  const startEl = findAnchorElement(doc, startFragment) ?? body;
  const endEl = endFragment ? findAnchorElement(doc, endFragment) : null;

  if (!startFragment && !endFragment) {
    return html;
  }

  const range = doc.createRange();
  range.setStartBefore(startEl);
  if (endEl && endEl !== startEl) {
    range.setEndBefore(endEl);
  } else {
    range.setEndAfter(body.lastChild || body);
  }

  const fragment = range.cloneContents();
  const wrapper = doc.createElement("div");
  wrapper.appendChild(fragment);
  return wrapper.innerHTML;
}

function titleFromHtml(html: string): string | undefined {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const heading = doc.querySelector("h1, h2, h3, title");
  const text = heading ? textFromElement(heading) : "";
  if (text && text.length <= 60) return text;
  return undefined;
}

function parseNcxNav(ncxXml: string, ncxPath: string): NavEntry[] {
  const ncxDoc = new DOMParser().parseFromString(ncxXml, "application/xml");
  const ncxDir = ncxPath.includes("/")
    ? ncxPath.slice(0, ncxPath.lastIndexOf("/") + 1)
    : "";
  const entries: NavEntry[] = [];
  let order = 0;

  for (const navPoint of Array.from(ncxDoc.getElementsByTagName("navPoint"))) {
    const label =
      navPoint.getElementsByTagName("text")[0]?.textContent?.trim() || "";
    const src =
      navPoint.getElementsByTagName("content")[0]?.getAttribute("src") || "";
    if (!label || !src) continue;
    const resolved = resolvePath(ncxDir, src);
    const { path, fragment } = splitHref(resolved);
    entries.push({
      href: path,
      fragment,
      title: label,
      order: order++,
    });
  }

  return entries;
}

function parseEpub3Nav(navHtml: string, navPath: string): NavEntry[] {
  const doc = new DOMParser().parseFromString(navHtml, "text/html");
  const navDir = navPath.includes("/")
    ? navPath.slice(0, navPath.lastIndexOf("/") + 1)
    : "";
  const entries: NavEntry[] = [];
  let order = 0;

  const tocNav =
    doc.querySelector('nav[epub\\:type~="toc"], nav[*|type="toc"], nav#toc') ??
    doc.querySelector("nav");

  if (!tocNav) return entries;

  for (const link of Array.from(tocNav.querySelectorAll("a[href]"))) {
    const href = link.getAttribute("href");
    const title = textFromElement(link);
    if (!href || !title) continue;
    const resolved = resolvePath(navDir, href);
    const { path, fragment } = splitHref(resolved);
    entries.push({
      href: path,
      fragment,
      title,
      order: order++,
    });
  }

  return entries;
}

function buildChaptersForSpineItem(
  spineId: string,
  filePath: string,
  html: string,
  navEntries: NavEntry[],
): BookChapter[] {
  const fileKey = normalizePathKey(filePath);
  const points = navEntries
    .filter((entry) => normalizePathKey(entry.href) === fileKey)
    .sort((a, b) => a.order - b.order);

  if (points.length <= 1) {
    const slice = points[0]
      ? sliceHtmlByAnchors(html, points[0].fragment)
      : html;
    const paragraphs = extractParagraphs(slice);
    if (paragraphs.length === 0) return [];

    const chapterTitle =
      points[0]?.title ||
      titleFromHtml(slice) ||
      paragraphs.find((p) => p.length < 40)?.slice(0, 40) ||
      `第 1 章`;

    return [
      {
        id: points[0]?.fragment ? `${spineId}#${points[0].fragment}` : spineId,
        href: filePath,
        title: chapterTitle,
        paragraphs,
      },
    ];
  }

  const chapters: BookChapter[] = [];
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[i + 1];
    const slice = sliceHtmlByAnchors(
      html,
      current.fragment,
      next?.fragment,
    );
    const paragraphs = extractParagraphs(slice);
    if (paragraphs.length === 0) continue;

    chapters.push({
      id: current.fragment
        ? `${spineId}#${current.fragment}`
        : `${spineId}-${i}`,
      href: filePath,
      title:
        current.title ||
        titleFromHtml(slice) ||
        paragraphs.find((p) => p.length < 40)?.slice(0, 40) ||
        `第 ${chapters.length + 1} 章`,
      paragraphs,
    });
  }

  return chapters;
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
    getMeta("dc:title") || getMeta("title") || "未命名书籍";
  const author =
    getMeta("dc:creator") || getMeta("creator") || "未知作者";

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

  const spineRefs = Array.from(opfDoc.getElementsByTagName("itemref")).map(
    (el) => ({
      id: el.getAttribute("idref") || "",
      linear: el.getAttribute("linear") !== "no",
    }),
  );

  const spineIds = spineRefs
    .filter((ref) => ref.id && ref.linear)
    .map((ref) => ref.id);

  const fallbackSpineIds = spineRefs
    .filter((ref) => ref.id)
    .map((ref) => ref.id);

  const effectiveSpineIds =
    spineIds.length > 0 ? spineIds : fallbackSpineIds;

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

  const navEntries: NavEntry[] = [];

  const ncxItem = Array.from(manifest.values()).find(
    (v) =>
      v.mediaType === "application/x-dtbncx+xml" ||
      v.href.toLowerCase().endsWith(".ncx"),
  );
  if (ncxItem) {
    const ncxPath = resolvePath(opfDir, ncxItem.href);
    const ncxFile = findZipFile(zip, ncxPath);
    if (ncxFile) {
      navEntries.push(...parseNcxNav(await ncxFile.async("text"), ncxPath));
    }
  }

  const navItem = Array.from(manifest.entries()).find(([, v]) =>
    (v.properties || "").includes("nav"),
  );
  if (navItem) {
    const navPath = resolvePath(opfDir, navItem[1].href);
    const navFile = findZipFile(zip, navPath);
    if (navFile) {
      navEntries.push(
        ...parseEpub3Nav(await navFile.async("text"), navPath),
      );
    }
  }

  const dedupedNav = navEntries.filter((entry, index, all) => {
    const key = `${normalizePathKey(entry.href)}#${entry.fragment || ""}`;
    return (
      all.findIndex(
        (other) =>
          `${normalizePathKey(other.href)}#${other.fragment || ""}` === key,
      ) === index
    );
  });

  const chapters: BookChapter[] = [];
  for (let i = 0; i < effectiveSpineIds.length; i++) {
    const spineId = effectiveSpineIds[i];
    const item = manifest.get(spineId);
    if (!item) continue;

    const isHtml =
      /html|xml|xhtml/i.test(item.mediaType) ||
      /\.x?html?$/i.test(item.href) ||
      item.mediaType === "";
    if (!isHtml) continue;

    const href = resolvePath(opfDir, item.href);
    const file = findZipFile(zip, href);
    if (!file) continue;

    const html = await file.async("text");
    const fileChapters = buildChaptersForSpineItem(
      spineId,
      href,
      html,
      dedupedNav,
    );

    if (fileChapters.length === 0) {
      const paragraphs = extractParagraphs(html);
      if (paragraphs.length === 0) continue;
      chapters.push({
        id: spineId,
        href,
        title:
          titleFromHtml(html) ||
          paragraphs.find((p) => p.length < 40)?.slice(0, 40) ||
          `第 ${chapters.length + 1} 章`,
        paragraphs,
      });
      continue;
    }

    chapters.push(...fileChapters);
  }

  if (chapters.length === 0 && dedupedNav.length > 0) {
    const seen = new Set<string>();
    for (const entry of dedupedNav) {
      const key = normalizePathKey(entry.href);
      if (seen.has(key)) continue;
      const file = findZipFile(zip, entry.href);
      if (!file) continue;
      seen.add(key);
      const html = await file.async("text");
      const fileChapters = buildChaptersForSpineItem(
        entry.href,
        entry.href,
        html,
        dedupedNav,
      );
      chapters.push(...fileChapters);
    }
  }

  if (chapters.length === 0) {
    throw new Error("未能从 EPUB 中提取可读文本");
  }

  return {
    title,
    author,
    coverDataUrl,
    chapters: chapters.map((chapter, index) => ({
      ...chapter,
      title: chapter.title || `第 ${index + 1} 章`,
    })),
  };
}
