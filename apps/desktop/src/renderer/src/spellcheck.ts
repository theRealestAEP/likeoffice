/**
 * App-side spellcheck over the engine's rendered pages.
 *
 * Why not Chromium's built-in spellchecker: the engine's editable surface is
 * not contentEditable. It renders plain positioned spans, owns its caret and
 * selection, and keeps keyboard focus on a hidden textarea (spellcheck=false).
 * Chromium only marks focused editable regions, so it never squiggles this
 * surface and the webContents context-menu event never carries misspelledWord.
 *
 * So the app does it: walk the rendered text spans, tokenize, check the words
 * in the main process (hunspell dictionary over IPC), and paint wavy
 * underlines as absolutely positioned divs INSIDE each page's item surface —
 * they share the page coordinate space, so scrolling and zooming need no
 * repositioning. A re-render drops them; the MutationObserver re-scans.
 *
 * Right-click on a squiggled word shows a NATIVE menu (main process): the
 * engine preventDefaults contextmenu over text for its own DOM menu, so this
 * module intercepts in the capture phase — only over misspelled words — and
 * everything else keeps the engine's menu.
 *
 * Replacement seam (why the odd synthetic event): the engine's public API has
 * no "select this exact range". Its double-click path (mouseup with detail 2)
 * selects the whitespace-delimited token at a point through the engine's own
 * selection machinery, and api.insertSymbol() funnels through the engine's
 * typing path (insertText: history checkpoint, collab intents, tracked
 * changes). So: synthetic double-click mouseup at the clicked point selects
 * the token, then insertSymbol(corrected token) replaces it exactly like
 * typed input. The engine scopes its token to one text run, so the
 * replacement token here is scoped to one rendered span; a word the layout
 * split across spans (rare: mid-word line wrap, mixed formatting) gets a
 * squiggle but no menu rather than a risky replacement.
 */
import type { DocxViewApi } from "wordinweb";

const WORD_RE = /[\p{L}\p{M}'’]+/gu;
const SQUIGGLE_CLASS = "lo-squiggle";
const SQUIGGLE_H = 3;

interface Part {
  el: HTMLElement;
  node: Text;
  text: string;
  /** Offset of this part's text within the segment text. */
  start: number;
}

/** A visual line of adjacent text spans, joined so a word that a run split
 * mid-word ("beau"+"tiful" with mixed bold) checks as one word. */
interface Segment {
  parts: Part[];
  text: string;
}

interface Found {
  segment: Segment;
  word: string;
  start: number;
  end: number;
}

interface WordHit {
  word: string;
  /** Live range over the word; rects are read fresh at hit-test time. */
  range: Range;
  /** Whitespace-delimited token around the word, scoped to its single span —
   * mirrors what the engine's double-click selection will select. */
  token: string;
  tokenWordStart: number;
  tokenWordEnd: number;
  clickTarget: HTMLElement;
}

export interface SpellcheckController {
  /** Drop cached verdicts and re-scan (language change, dictionary add). */
  refresh(): void;
  dispose(): void;
}

function collectSegments(page: HTMLElement): Segment[] {
  const spans = page.querySelectorAll<HTMLElement>('[data-dxw-item-kind="text"]');
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let prevRect: DOMRect | null = null;
  for (const el of spans) {
    const node = Array.from(el.childNodes).find(
      (n): n is Text => n.nodeType === Node.TEXT_NODE,
    );
    if (!node || !node.data) {
      current = null;
      prevRect = null;
      continue;
    }
    const rect = el.getBoundingClientRect();
    const joins =
      current !== null &&
      prevRect !== null &&
      Math.abs(rect.top - prevRect.top) < 2 &&
      Math.abs(rect.left - prevRect.right) < 2;
    if (!joins) {
      current = { parts: [], text: "" };
      segments.push(current);
    }
    current!.parts.push({ el, node, text: node.data, start: current!.text.length });
    current!.text += node.data;
    prevRect = rect;
  }
  return segments;
}

function wordsOf(segment: Segment): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  for (const m of segment.text.matchAll(WORD_RE)) {
    let word = m[0];
    let start = m.index ?? 0;
    while (word.length > 0 && /['’]/.test(word[0])) {
      word = word.slice(1);
      start++;
    }
    while (word.length > 0 && /['’]/.test(word[word.length - 1])) word = word.slice(0, -1);
    if (word.length < 2) continue;
    const end = start + word.length;
    // The surrounding whitespace-delimited token decides whether this is
    // prose at all: skip URLs, emails, paths, and digit-glued tokens ("5th").
    let ws = start;
    while (ws > 0 && !/\s/.test(segment.text[ws - 1])) ws--;
    let we = end;
    while (we < segment.text.length && !/\s/.test(segment.text[we])) we++;
    const token = segment.text.slice(ws, we);
    if (/[0-9@/\\]/.test(token)) continue;
    out.push({ word, start, end });
  }
  return out;
}

/** Map a segment offset to its part and local offset. */
function partAt(segment: Segment, offset: number, endBias: boolean): Part | null {
  for (const part of segment.parts) {
    const end = part.start + part.text.length;
    if (offset < end || (endBias && offset === end)) {
      if (offset >= part.start) return part;
    }
  }
  return null;
}

export function attachSpellcheck(
  container: HTMLElement,
  api: DocxViewApi,
  onEdited: () => void,
): SpellcheckController {
  /** word → spelled correctly. Cleared on language / dictionary changes. */
  const cache = new Map<string, boolean>();
  let hits: WordHit[] = [];
  let generation = 0;
  let timer: number | null = null;
  let disposed = false;

  function schedule(delay = 400): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void scan();
    }, delay);
  }

  function isOwnMutation(m: MutationRecord): boolean {
    const own = (n: Node) =>
      n instanceof HTMLElement && n.classList.contains(SQUIGGLE_CLASS);
    return (
      m.type === "childList" &&
      m.addedNodes.length + m.removedNodes.length > 0 &&
      Array.from(m.addedNodes).every(own) &&
      Array.from(m.removedNodes).every(own)
    );
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.every(isOwnMutation)) return;
    schedule();
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });

  async function scan(): Promise<void> {
    if (disposed) return;
    const gen = ++generation;
    const found: Found[] = [];
    for (const page of container.querySelectorAll<HTMLElement>(".dxw-page")) {
      for (const segment of collectSegments(page)) {
        for (const w of wordsOf(segment)) found.push({ segment, ...w });
      }
    }
    const unknown = [...new Set(found.map((f) => f.word))].filter((w) => !cache.has(w));
    if (unknown.length > 0) {
      const misspelled = new Set(await window.likeoffice.spellCheck(unknown));
      if (disposed || gen !== generation) return;
      for (const w of unknown) cache.set(w, !misspelled.has(w));
    }
    paint(found.filter((f) => cache.get(f.word) === false));
  }

  function paint(list: Found[]): void {
    for (const el of container.querySelectorAll(`.${SQUIGGLE_CLASS}`)) el.remove();
    hits = [];
    for (const f of list) {
      const startPart = partAt(f.segment, f.start, false);
      const endPart = partAt(f.segment, f.end, true);
      if (!startPart || !endPart) continue;
      const surface = startPart.el.parentElement;
      if (!surface) continue;
      const range = document.createRange();
      range.setStart(startPart.node, f.start - startPart.start);
      range.setEnd(endPart.node, f.end - endPart.start);
      const surfRect = surface.getBoundingClientRect();
      const scale = surface.offsetWidth > 0 ? surfRect.width / surface.offsetWidth : 1;
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0) continue;
        const div = document.createElement("div");
        div.className = SQUIGGLE_CLASS;
        div.style.left = `${(rect.left - surfRect.left) / scale}px`;
        div.style.top = `${(rect.bottom - surfRect.top) / scale - SQUIGGLE_H}px`;
        div.style.width = `${rect.width / scale}px`;
        div.style.height = `${SQUIGGLE_H}px`;
        surface.appendChild(div);
      }
      // The menu (and its replacement) only for words inside ONE span; see
      // the module comment for why split words get a squiggle but no menu.
      if (startPart !== endPart) continue;
      const local = f.start - startPart.start;
      const localEnd = f.end - startPart.start;
      let ts = local;
      while (ts > 0 && !/\s/.test(startPart.text[ts - 1])) ts--;
      let te = localEnd;
      while (te < startPart.text.length && !/\s/.test(startPart.text[te])) te++;
      hits.push({
        word: f.word,
        range,
        token: startPart.text.slice(ts, te),
        tokenWordStart: local - ts,
        tokenWordEnd: localEnd - ts,
        clickTarget: startPart.el,
      });
    }
  }

  function hitAt(x: number, y: number): WordHit | null {
    for (const hit of hits) {
      for (const r of hit.range.getClientRects()) {
        // A little slack below the baseline so a click on the squiggle counts.
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + SQUIGGLE_H) {
          return hit;
        }
      }
    }
    return null;
  }

  async function showMenu(hit: WordHit, x: number, y: number): Promise<void> {
    // Select the token first (like every native editor highlights the word):
    // the engine's own double-click path does the selecting, so the
    // replacement below targets exactly what the user sees selected.
    hit.clickTarget.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, detail: 2, clientX: x, clientY: y }),
    );
    const suggestions = await window.likeoffice.spellSuggest(hit.word);
    const action = await window.likeoffice.spellMenu(hit.word, suggestions, x, y);
    if (!action || disposed) return;
    if (action.type === "replace") {
      const t = hit.token;
      const replacement = t.slice(0, hit.tokenWordStart) + action.text + t.slice(hit.tokenWordEnd);
      // insertSymbol funnels through the engine's typing path (insertText):
      // undo, collab intents, and tracked changes behave like typed input.
      if (api.insertSymbol(replacement)) onEdited();
    } else {
      await window.likeoffice.spellAddWord(hit.word);
      cache.clear();
      schedule(0);
    }
  }

  const onContextMenu = (e: MouseEvent): void => {
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) return; // everything else keeps the engine's own menu
    e.preventDefault();
    e.stopPropagation();
    void showMenu(hit, e.clientX, e.clientY);
  };
  // Capture phase: runs before the engine's bubble-phase contextmenu handler.
  container.addEventListener("contextmenu", onContextMenu, true);

  schedule(300);

  return {
    refresh() {
      cache.clear();
      schedule(0);
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      container.removeEventListener("contextmenu", onContextMenu, true);
      if (timer !== null) window.clearTimeout(timer);
      for (const el of container.querySelectorAll(`.${SQUIGGLE_CLASS}`)) el.remove();
    },
  };
}
