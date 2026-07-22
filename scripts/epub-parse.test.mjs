import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { DOMParser } from "linkedom";

globalThis.DOMParser = DOMParser;

const { parseEpub } = await import("../src/lib/epub.ts");

async function makeSampleEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  const bodyContent = Array.from({ length: 5 }, (_, i) => `
    <h2 id="ch${i + 1}">第${i + 1}章</h2>
    <p>这是第${i + 1}章的正文内容，用于测试目录锚点拆分。</p>
    <p>第二段文字 ${i + 1}。</p>
  `).join("\n");

  zip.file(
    "OEBPS/Text/part0001.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>正文</title></head>
<body>${bodyContent}</body>
</html>`,
  );

  zip.file(
    "OEBPS/Text/cover.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>封面</p></body></html>`,
  );

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试书</dc:title>
    <dc:creator>作者</dc:creator>
    <dc:identifier id="uid">test-uid</dc:identifier>
  </metadata>
  <manifest>
    <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="part1" href="Text/part0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover"/>
    <itemref idref="part1"/>
  </spine>
</package>`,
  );

  const navPoints = Array.from({ length: 5 }, (_, i) => `
    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>第${i + 1}章</text></navLabel>
      <content src="Text/part0001.xhtml#ch${i + 1}"/>
    </navPoint>
  `).join("");

  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="test-uid"/></head>
  <docTitle><text>测试书</text></docTitle>
  <navMap>${navPoints}</navMap>
</ncx>`,
  );

  return zip.generateAsync({ type: "arraybuffer" });
}

test("spine 2 项 + NCX 多锚点应拆出多章", async () => {
  const data = await makeSampleEpub();
  const parsed = await parseEpub(data);
  assert.ok(
    parsed.chapters.length >= 5,
    `期望至少 5 章，实际 ${parsed.chapters.length}`,
  );
  assert.ok(
    parsed.chapters.some((ch) => ch.title.includes("第1章")),
    "应包含第1章",
  );
});
