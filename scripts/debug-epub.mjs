#!/usr/bin/env node
/**
 * EPUB 结构诊断脚本
 * 用法: node scripts/debug-epub.mjs /path/to/book.epub
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "linkedom";

globalThis.DOMParser = DOMParser;

const epubPath = process.argv[2];
if (!epubPath) {
  console.error("用法: node scripts/debug-epub.mjs <file.epub>");
  process.exit(1);
}

const { parseEpub } = await import("../src/lib/epub.ts");

const data = fs.readFileSync(path.resolve(epubPath)).buffer;
const zip = await JSZip.loadAsync(data);

function findZipFile(zip, p) {
  const normalized = p.replace(/^\.\//, "").replace(/^\/+/, "");
  const direct = zip.file(normalized);
  if (direct) return direct;
  const lower = normalized.toLowerCase();
  const match = Object.keys(zip.files).find(
    (k) => k.replace(/\\/g, "/").toLowerCase() === lower,
  );
  return match ? zip.file(match) : null;
}

const containerXml = await findZipFile(zip, "META-INF/container.xml").async("text");
const containerDoc = new DOMParser().parseFromString(containerXml, "application/xml");
const rootfile = containerDoc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
const opfXml = await findZipFile(zip, rootfile).async("text");
const opfDoc = new DOMParser().parseFromString(opfXml, "application/xml");

const spine = Array.from(opfDoc.getElementsByTagName("itemref")).map((el) => ({
  idref: el.getAttribute("idref"),
  linear: el.getAttribute("linear"),
}));

const manifest = Array.from(opfDoc.getElementsByTagName("item")).map((el) => ({
  id: el.getAttribute("id"),
  href: el.getAttribute("href"),
  mediaType: el.getAttribute("media-type"),
  properties: el.getAttribute("properties"),
}));

const ncx = manifest.find(
  (m) =>
    m.mediaType === "application/x-dtbncx+xml" ||
    m.href?.toLowerCase().endsWith(".ncx"),
);
let ncxPoints = 0;
if (ncx) {
  const opfDir = rootfile.includes("/")
    ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1)
    : "";
  const ncxPath = path.posix.join(opfDir, ncx.href).replace(/\\/g, "/");
  const ncxXml = await findZipFile(zip, ncxPath).async("text");
  const ncxDoc = new DOMParser().parseFromString(ncxXml, "application/xml");
  ncxPoints = ncxDoc.getElementsByTagName("navPoint").length;
}

const navItem = manifest.find((m) => (m.properties || "").includes("nav"));
let navLinks = 0;
if (navItem) {
  const opfDir = rootfile.includes("/")
    ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1)
    : "";
  const navPath = path.posix.join(opfDir, navItem.href).replace(/\\/g, "/");
  const navHtml = await findZipFile(zip, navPath).async("text");
  const navDoc = new DOMParser().parseFromString(navHtml, "text/html");
  navLinks = navDoc.querySelectorAll("nav a[href], a[href]").length;
}

const parsed = await parseEpub(data);

console.log("=== EPUB 诊断 ===");
console.log("文件:", epubPath);
console.log("OPF:", rootfile);
console.log("Spine 项数:", spine.length);
console.log("Manifest HTML 项:", manifest.filter((m) => /html|xhtml/i.test(m.mediaType || m.href || "")).length);
console.log("NCX navPoint 数:", ncxPoints);
console.log("EPUB3 nav 链接数:", navLinks);
console.log("解析出章节数:", parsed.chapters.length);
console.log("\nSpine:");
for (const s of spine.slice(0, 10)) {
  const item = manifest.find((m) => m.id === s.idref);
  console.log(`  - ${s.idref} linear=${s.linear ?? "yes"} href=${item?.href}`);
}
if (spine.length > 10) console.log(`  ... 还有 ${spine.length - 10} 项`);
console.log("\n前 15 章:");
for (const ch of parsed.chapters.slice(0, 15)) {
  console.log(`  ${ch.title} (${ch.paragraphs.length} 段) href=${ch.href}`);
}
