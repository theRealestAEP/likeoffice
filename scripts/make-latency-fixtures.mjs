#!/usr/bin/env node
/**
 * Build the two typing-latency fixtures as real .docx packages.
 *
 * A .docx is a plain zip, so this writes the parts and shells out to `zip` —
 * no dependency to resolve from whichever repo happens to run it.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const OUT = process.argv[2] ?? ".";

const SENTENCE =
  "the quick brown fox jumps over the lazy dog while the committee deliberates at length. ";

function paraText(i, chars) {
  const head = `Paragraph ${i}: `;
  if (chars <= 0) return head + SENTENCE;
  let text = head;
  while (text.length < chars) text += SENTENCE;
  return text.slice(0, chars);
}

function build(name, paras, chars) {
  const dir = join(OUT, `.build-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "_rels"), { recursive: true });
  mkdirSync(join(dir, "word"), { recursive: true });

  let body = "";
  for (let i = 0; i < paras; i++) {
    body += `<w:p><w:r><w:t xml:space="preserve">${paraText(i, chars)}</w:t></w:r></w:p>`;
  }
  writeFileSync(
    join(dir, "word", "document.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
      `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  writeFileSync(
    join(dir, "[Content_Types].xml"),
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  writeFileSync(
    join(dir, "_rels", ".rels"),
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );

  // ABSOLUTE: `zip` runs with cwd set to the build dir, which is then deleted.
  const docx = resolve(OUT, `${name}.docx`);
  rmSync(docx, { force: true });
  execFileSync("zip", ["-q", "-X", "-r", docx, "[Content_Types].xml", "_rels", "word"], { cwd: dir });
  rmSync(dir, { recursive: true, force: true });

  const totalChars = paras * (chars > 0 ? chars : SENTENCE.length + 14);
  console.log(`${docx}  paragraphs=${paras} charsPerPara=${chars || "short"} totalChars=${totalChars}`);
}

// The user's document: 245 paragraphs, 794,298 characters.
build("bigparas", 245, 3240);
// A novel of the same length, in ordinary paragraphs.
build("novel", 6000, 132);
