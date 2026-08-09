/**
 * Live word count, bottom-right of the document area.
 *
 * All statistics come from the engine's DocxViewApi.wordCount() when this
 * engine build has it (feature-detected). It returns a TextStatistics object
 * — words, characters, charactersWithSpaces, paragraphs, pages — never a bare
 * number. For engine builds without the API, a small duck-typed walk over
 * api.document counts body text the way Word's status bar does: body story
 * only (no headers, footers, or notes), field cached results included, tokens
 * split on whitespace, characters with spaces, non-empty paragraphs.
 */
import { useEffect, useRef, useState } from "react";
import type { DocxViewApi } from "wordinweb";

interface Stats {
  words: number;
  characters: number;
  paragraphs: number;
  pages: number;
}

/** Minimal shapes of the engine model this walk touches. */
interface ModelRun {
  type?: string;
  runs?: ModelRun[];
  content?: { kind?: string; text?: string; cachedResult?: string }[];
}
interface ModelBlock {
  type?: string;
  children?: ModelRun[];
  revisionHidden?: boolean;
  rows?: { cells?: { blocks?: ModelBlock[] }[] }[];
}

function paragraphText(children: ModelRun[]): string {
  let text = "";
  for (const child of children) {
    const runs = child.type === "run" ? [child] : (child.runs ?? []);
    for (const run of runs) {
      for (const c of run.content ?? []) {
        if (c.kind === "text" && typeof c.text === "string") text += c.text;
        else if (c.kind === "field" && typeof c.cachedResult === "string") text += c.cachedResult;
        else if (c.kind === "tab" || c.kind === "break") text += " ";
      }
    }
  }
  return text;
}

function countBlocks(blocks: ModelBlock[], stats: { words: number; characters: number; paragraphs: number }): void {
  for (const block of blocks) {
    if (block.type === "paragraph" && !block.revisionHidden) {
      const text = paragraphText(block.children ?? []);
      stats.characters += text.length;
      const words = text.split(/\s+/).filter(Boolean);
      stats.words += words.length;
      if (words.length > 0) stats.paragraphs++;
    } else if (block.type === "table") {
      for (const row of block.rows ?? []) {
        for (const cell of row.cells ?? []) countBlocks(cell.blocks ?? [], stats);
      }
    }
  }
}

/** DocxViewApi.wordCount()'s return shape (the engine's TextStatistics plus
 * the page count). It is an object, never a bare number. */
interface EngineStatistics {
  words: number;
  charactersWithSpaces: number;
  paragraphs: number;
  pages: number;
}

export function computeStats(api: DocxViewApi): Stats {
  // Prefer the engine's own statistics when this build has them (see module note).
  const wordCount = (api as { wordCount?: () => EngineStatistics }).wordCount;
  if (typeof wordCount === "function") {
    const s = wordCount.call(api);
    return { words: s.words, characters: s.charactersWithSpaces, paragraphs: s.paragraphs, pages: s.pages };
  }
  const stats = { words: 0, characters: 0, paragraphs: 0 };
  const doc = api.document as unknown as { sections?: { blocks?: ModelBlock[] }[] };
  for (const section of doc.sections ?? []) countBlocks(section.blocks ?? [], stats);
  return { ...stats, pages: api.pageCount() };
}

/** UX guard: a stat that is somehow non-finite paints as "—", never "NaN". */
export const fmt = (n: number): string => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");

export function WordCount({ api, observeEl }: { api: DocxViewApi; observeEl: HTMLElement | null }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const compute = () => setStats(computeStats(api));
    compute();
    if (!observeEl) return;
    const observer = new MutationObserver(() => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(compute, 500);
    });
    observer.observe(observeEl, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [api, observeEl]);

  if (!stats) return null;
  return (
    <div className="word-count-anchor">
      {open && (
        <div className="word-count-popover" data-testid="word-count-popover">
          <div className="word-count-row">
            <span>Pages</span>
            <span>{fmt(stats.pages)}</span>
          </div>
          <div className="word-count-row">
            <span>Words</span>
            <span>{fmt(stats.words)}</span>
          </div>
          <div className="word-count-row">
            <span>Characters</span>
            <span>{fmt(stats.characters)}</span>
          </div>
          <div className="word-count-row">
            <span>Paragraphs</span>
            <span>{fmt(stats.paragraphs)}</span>
          </div>
        </div>
      )}
      <button
        className="word-count"
        data-testid="word-count"
        onClick={() => setOpen((o) => !o)}
        title="Word count — click for details"
        aria-expanded={open}
      >
        {fmt(stats.words)} {stats.words === 1 ? "word" : "words"}
      </button>
    </div>
  );
}
