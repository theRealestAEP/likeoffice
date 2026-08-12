/**
 * Routes application-menu actions to the document.
 *
 * Three routes, in order of preference:
 *
 *  1. A DocxViewApi call, for commands that need no further input.
 *  2. The toolbar's own popover or dialog, for commands whose value is the
 *     picker (find & replace, the table grid, the symbol gallery, …). The
 *     toolbar exposes no host API, so these go through a click on the control,
 *     found by its title. Building a second Find dialog beside the engine's is
 *     the thing this avoids.
 *  3. A keydown replayed into the engine's own handler, for the three commands
 *     with no api at all — Select All, Delete — and for Bold/Italic/Underline,
 *     where the engine's shortcut does more than applyFormat: with a bare caret
 *     it queues the format for the next typed text.
 *
 * A menu accelerator wins over the renderer, so every key the menu binds must
 * arrive here; see main/menu.ts.
 */
import type { DocxViewApi } from "wordinweb";

export interface MenuActionContext {
  api: DocxViewApi;
  /** Called after an action that changed the document. */
  markDirty(): void;
}

/**
 * Two frames: React renders the popover on the first, lays it out on the
 * second. An occluded window runs no animation frames at all, so a timer
 * bounds the wait — otherwise one menu action's tail can land after the next
 * action has already run, and undo it.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 50);
  });
}

/**
 * The DocxView scroll container, which is where the engine listens for keys.
 * It is the ancestor the engine gave `tabIndex = 0`; the pages are inside it.
 */
function engineContainer(): HTMLElement | null {
  return document.querySelector(".dxw-page")?.closest<HTMLElement>('[tabindex="0"]') ?? null;
}

function replayKey(key: string, withModifier: boolean): void {
  const el = engineContainer();
  if (!el) return;
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      metaKey: withModifier,
      ctrlKey: withModifier,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function toolbarRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".app-toolbar-slot");
}

/** The toolbar moves `title` into `data-tip` the first time a control is
 * hovered, so both spellings have to be searched. */
function control(title: string): HTMLElement | null {
  return toolbarRoot()?.querySelector<HTMLElement>(`[title="${title}"], [data-tip="${title}"]`) ?? null;
}

/** A control the ribbon folded away is display:none — and so is the popover it
 * opens. Expanding the bar first is what makes the click visible. */
async function unfold(el: HTMLElement): Promise<void> {
  if (el.offsetParent !== null) return;
  toolbarRoot()?.querySelector<HTMLElement>("[data-dxw-toolbar-expand]")?.click();
  await settle();
}

async function selectTab(tab: string): Promise<void> {
  const btn = toolbarRoot()?.querySelector<HTMLElement>(`[data-dxw-toolbar-tabs] [data-tab="${tab}"]`);
  if (!btn || btn.getAttribute("aria-pressed") === "true") return;
  btn.click();
  await settle();
}

async function openToolbarControl(tab: string, title: string): Promise<void> {
  await selectTab(tab);
  const el = control(title);
  if (!el) return;
  await unfold(el);
  (control(title) ?? el).click();
}

/**
 * Which ribbon tab holds each control, and the title it carries there. These
 * titles are the engine's, so e2e checks every one of them still resolves —
 * a renamed tooltip would otherwise turn a menu item into a no-op.
 */
export const TOOLBAR_CONTROLS: Record<string, [tab: string, title: string]> = {
  "insert:table": ["insert", "Table"],
  "insert:picture": ["insert", "Insert image"],
  "insert:link": ["insert", "Insert link"],
  "insert:comment": ["insert", "Add comment (select text first)"],
  "insert:footnote": ["insert", "Insert footnote (at the caret)"],
  "insert:endnote": ["insert", "Insert endnote (at the caret)"],
  "insert:page-numbers": ["insert", "Insert a page number and choose its format"],
  "insert:header-footer": ["insert", "Edit the repeating header or footer"],
  "insert:equation": ["insert", "Insert equation"],
  "insert:symbol": ["insert", "Insert advanced symbol"],
  "insert:date-time": ["insert", "Insert an automatically updating date or time"],
  "insert:toc": ["insert", "Insert or update a table of contents"],
  "insert:caption": ["insert", "Insert a caption for the selected object or table"],
  "insert:cross-reference": ["insert", "Insert cross-reference"],
  "insert:bookmark": ["insert", "Insert bookmark"],
  "insert:quick-parts": ["insert", "Quick Parts: save and reuse content"],
  borders: ["home", "Paragraph borders and shading"],
  tabs: ["home", "Tab stops"],
};

/** Find, Find and Replace and Go To are one popover with three fields; each
 * item opens it and puts the caret in its own field. */
async function openFind(fieldLabel: string): Promise<void> {
  if (!document.querySelector('input[aria-label="Find text"]')) {
    await openToolbarControl("review", "Find & replace");
    await settle();
  }
  document.querySelector<HTMLInputElement>(`input[aria-label="${fieldLabel}"]`)?.focus();
}

/** Page Setup is the Layout ribbon's Custom Margins dialog. */
async function openPageSetup(): Promise<void> {
  await selectTab("layout");
  const trigger = toolbarRoot()?.querySelector<HTMLElement>('[data-dxw-layout-menu-trigger="margins"]');
  if (!trigger) return;
  await unfold(trigger);
  trigger.click();
  await settle();
  // The layout menus render into a portal, so they are not under the toolbar.
  document
    .querySelector<HTMLElement>('[data-dxw-layout-menu="margins"] [data-dxw-layout-option="m:custom"]')
    ?.click();
}

/** The profiles manager lives behind the AI panel's profile picker, so the
 * panel has to be open before this runs. */
export async function openProfilesManager(): Promise<void> {
  await settle();
  document.querySelector<HTMLElement>('[data-testid="ai-profile-button"]')?.click();
  await settle();
  document.querySelector<HTMLElement>('[data-testid="ai-profile-manage"]')?.click();
}

/**
 * Run a menu action against the document. Returns false for actions this
 * module does not own (the window-level ones App handles itself).
 */
export function runMenuAction(action: string, ctx: MenuActionContext): boolean {
  const { api, markDirty } = ctx;
  const edit = (fn: () => void): true => {
    fn();
    markDirty();
    return true;
  };

  const toolbar = TOOLBAR_CONTROLS[action];
  if (toolbar) {
    void openToolbarControl(toolbar[0], toolbar[1]);
    return true;
  }

  const colon = action.indexOf(":");
  const head = colon < 0 ? "" : action.slice(0, colon);
  const arg = colon < 0 ? "" : action.slice(colon + 1);
  switch (head) {
    case "format": {
      const f = api.getSelectionFormat();
      switch (arg) {
        case "bold":
          return edit(() => replayKey("b", true));
        case "italic":
          return edit(() => replayKey("i", true));
        case "underline":
          return edit(() => replayKey("u", true));
        case "strike":
          return edit(() => api.applyFormat({ strike: !f?.strike }));
        case "superscript":
          return edit(() =>
            api.applyFormat({ verticalAlign: f?.verticalAlign === "superscript" ? null : "superscript" }),
          );
        case "subscript":
          return edit(() =>
            api.applyFormat({ verticalAlign: f?.verticalAlign === "subscript" ? null : "subscript" }),
          );
      }
      return false;
    }
    case "style":
      return edit(() => api.setParagraphStyle(arg === "normal" ? null : arg));
    case "align":
      return edit(() => api.setAlignment(arg as "left" | "center" | "right" | "justify"));
    case "spacing":
      return edit(() => api.setParagraphSpacing({ lineMultiple: Number(arg) }));
    case "indent":
      return edit(() => api.adjustIndent(arg === "in" ? 1 : -1));
    case "list":
      return edit(() => api.toggleList(arg as "bullet" | "number"));
    case "list-preset":
      return edit(() => api.applyNumberingPreset(arg));
    case "insert":
      switch (arg) {
        case "page-break":
          return edit(() => api.insertBreak("page"));
        case "section-next-page":
          return edit(() => api.insertBreak("sectionNextPage"));
        case "section-continuous":
          return edit(() => api.insertBreak("sectionContinuous"));
      }
      return false;
  }

  switch (action) {
    case "undo":
      return edit(() => api.undo());
    case "redo":
      return edit(() => api.redo());
    case "delete":
      return edit(() => replayKey("Delete", false));
    case "select-all":
      replayKey("a", true);
      return true;
    case "clear-format":
      return edit(() => api.clearFormatting());
    case "print":
      api.print();
      return true;
    case "page-setup":
      void openPageSetup();
      return true;
    case "find":
      void openFind("Find text");
      return true;
    case "find-replace":
      void openFind("Replace with");
      return true;
    case "go-to":
      void openFind("Go to page");
      return true;
    case "find-next":
    case "find-prev": {
      // Nothing to step to before a search: open the popover instead of
      // reporting nothing at all.
      if (api.findStep(action === "find-next" ? 1 : -1) === 0) void openFind("Find text");
      return true;
    }
    case "track-changes":
      api.setSuggesting(!api.isSuggesting());
      return true;
    case "accept-all":
      return edit(() => api.acceptAllRevisions());
    case "reject-all":
      return edit(() => api.rejectAllRevisions());
  }
  return false;
}
