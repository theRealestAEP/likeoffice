import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DocxView,
  DocxToolbar,
  useAgentDocumentSession,
  type AgentDocumentViewBinding,
  type DocxViewApi,
  type HostShortcutSection,
} from "wordinweb";
import { AgentDocument, LocalDocumentSession, localDocumentViewBinding } from "@wordinweb/agent";
import { AiPanel } from "./AiPanel";
import { MailMerge } from "./MailMerge";
import { openProfilesManager, runMenuAction } from "./menu-actions";
import { SettingsDialog } from "./SettingsDialog";
import { attachSpellcheck } from "./spellcheck";
import { WordCount } from "./WordCount";

const EDIT_KEYS = new Set(["Enter", "Backspace", "Delete", "Tab"]);

const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2];

export function App() {
  const [doc, setDoc] = useState<InitialDocument | null>(null);
  // Revert replaces the document wholesale; a new key remounts the editor onto
  // the reloaded bytes rather than trying to patch the live session.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    void window.likeoffice
      .getInitialDocument()
      .then((d) => setDoc({ ...d, bytes: new Uint8Array(d.bytes) }));
  }, []);

  const reload = useCallback((next: InitialDocument) => {
    setDoc({ ...next, bytes: new Uint8Array(next.bytes) });
    setGeneration((n) => n + 1);
  }, []);

  if (!doc) return null;
  return <Editor key={generation} initial={doc} onReload={reload} />;
}

function Editor({
  initial,
  onReload,
}: {
  initial: InitialDocument;
  onReload: (next: InitialDocument) => void;
}) {
  const session = useMemo(() => new LocalDocumentSession(initial.bytes), [initial.bytes]);
  // The agent and view packages each bundle their own copy of the engine core,
  // so their DocxDocument types are nominally distinct. The shapes match.
  const binding = useMemo(
    () => localDocumentViewBinding(session) as unknown as AgentDocumentViewBinding,
    [session],
  );
  const agentDoc = useMemo(
    () => AgentDocument.connect(session, { provenance: { author: "AI" } }),
    [session],
  );
  const view = useAgentDocumentSession(binding);

  const [name, setName] = useState(initial.name);
  const [api, setApi] = useState<DocxViewApi | null>(null);
  const [dirty, setDirty] = useState(initial.dirty);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wordCountOpen, setWordCountOpen] = useState(false);
  // Mail-merge preview state. It lives HERE and nowhere else: the engine
  // resolves the record as it paints and writes nothing, so none of this
  // reaches the document, the undo stack or a saved file.
  const [mailingsOpen, setMailingsOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState<MergeDataSource | null>(null);
  const [mergeIndex, setMergeIndex] = useState(0);
  const [mergePreview, setMergePreview] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [settings, setSettings] = useState<SettingsView>({
    provider: "anthropic-api",
    hasKey: false,
    model: "",
    spellLanguage: "system",
  });
  const apiRef = useRef<DocxViewApi | null>(null);
  apiRef.current = api;
  const editorRef = useRef<HTMLDivElement | null>(null);
  // The DocxView root: spellcheck and the word count observe this subtree,
  // NOT .app-editor itself, so their own UI updates cannot re-trigger them.
  const [docRoot, setDocRoot] = useState<HTMLElement | null>(null);

  // The shortcuts sheet renders the engine's own key table, which cannot
  // include a key the application menu takes first. The live menu supplies
  // those, so the sheet describes the whole keyboard (see main/shortcuts.ts).
  const [menuShortcuts, setMenuShortcuts] = useState<HostShortcutSection[]>([]);

  useEffect(() => {
    void window.likeoffice.getSettings().then(setSettings);
    void window.likeoffice.getMenuShortcuts().then(setMenuShortcuts);
  }, []);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const timer = setInterval(() => {
      const a = apiRef.current;
      if (a && dirtyRef.current) window.likeoffice.autosave(a.save());
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    document.title = `${dirty ? "• " : ""}${name} — LikeOffice`;
    window.likeoffice.setDirty(dirty);
  }, [dirty, name]);

  const markDirty = useCallback(() => setDirty(true), []);

  // One clamp, read by both the counter and the painted record — so "Record 3
  // of 40" can never name a record other than the one on the page.
  const mergeRecords = mergeSource?.records ?? [];
  const mergeAt = Math.min(mergeIndex, Math.max(0, mergeRecords.length - 1));
  /** The record the engine paints, or undefined for the «Name» placeholders.
   * Undefined is preview "off" — there is no other switch. */
  const mergeRecord = mergePreview ? mergeRecords[mergeAt] : undefined;

  useEffect(() => {
    if (!api || !editorRef.current) return;
    setDocRoot(editorRef.current.firstElementChild as HTMLElement | null);
  }, [api]);

  // e2e seam: tests reach the view api (feature probes, count injection).
  useEffect(() => {
    (window as unknown as { __likeofficeApi?: DocxViewApi | null }).__likeofficeApi = api;
  }, [api]);

  useEffect(() => {
    if (!api || !docRoot) return;
    const spell = attachSpellcheck(docRoot, api, markDirty);
    const unsub = window.likeoffice.onSpellChanged(() => spell.refresh());
    return () => {
      unsub();
      spell.dispose();
    };
  }, [api, docRoot, markDirty]);

  const save = useCallback(async (saveAs: boolean) => {
    const a = apiRef.current;
    if (!a) return;
    const result = await window.likeoffice.saveDocument(a.save(), saveAs);
    if (result) {
      setName(result.name);
      setDirty(false);
    }
  }, []);

  useEffect(() => {
    return window.likeoffice.onMenu((action) => {
      const a = apiRef.current;
      // Window-level items live here; everything that acts on the document
      // goes to the router (see menu-actions.ts).
      switch (action) {
        case "save":
          void save(false);
          return;
        case "save-as":
          void save(true);
          return;
        case "duplicate":
          if (a) void window.likeoffice.duplicateDocument(a.save());
          return;
        case "revert":
          void window.likeoffice.revertDocument().then((next) => {
            if (next) onReload(next);
          });
          return;
        case "export-pdf": {
          const html = a?.exportPrintHtml();
          if (html) void window.likeoffice.exportPdf(html);
          return;
        }
        case "export-docx":
          if (a) void window.likeoffice.saveCopy(a.save());
          return;
        case "settings":
          setSettingsOpen(true);
          return;
        case "toggle-ai":
          setPanelOpen((open) => !open);
          return;
        case "ai-profiles":
          setPanelOpen(true);
          void openProfilesManager();
          return;
        case "word-count":
          setWordCountOpen((open) => !open);
          return;
        case "mail-merge":
          setMailingsOpen((open) => !open);
          return;
        case "zoom:in":
          setZoom((z) => ZOOM_STEPS.find((s) => s > z) ?? z);
          return;
        case "zoom:out":
          setZoom((z) => [...ZOOM_STEPS].reverse().find((s) => s < z) ?? z);
          return;
        case "zoom:reset":
          setZoom(1);
          return;
      }
      if (a) runMenuAction(action, { api: a, markDirty });
    });
  }, [markDirty, onReload, save]);

  return (
    <div className="app-shell">
      <div className="app-header">
        {/* Dirty tracking is heuristic until the engine grows a change event:
            any editing keystroke or toolbar interaction marks the document dirty. */}
        <div className="app-toolbar-slot" onMouseDownCapture={markDirty}>
          {api && <DocxToolbar api={api} mode="advanced" hostShortcuts={menuShortcuts} />}
        </div>
        <div className="app-header-cap">
          <button
            className="ai-toggle"
            onClick={() => setPanelOpen((open) => !open)}
            aria-pressed={panelOpen}
            title="Toggle the AI assistant"
            data-testid="ai-toggle"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 1.5c.6 2.9 1.6 3.9 4.5 4.5v.9c-2.9.6-3.9 1.6-4.5 4.5h-.9c-.6-2.9-1.6-3.9-4.5-4.5V6c2.9-.6 3.9-1.6 4.5-4.5h.9Z" />
              <path d="M12.5 10c.35 1.6.9 2.15 2.5 2.5v.6c-1.6.35-2.15.9-2.5 2.5h-.6c-.35-1.6-.9-2.15-2.5-2.5v-.6c1.6-.35 2.15-.9 2.5-2.5h.6Z" />
            </svg>
            AI
          </button>
        </div>
      </div>
      {api && (
        <MailMerge
          api={api}
          open={mailingsOpen}
          source={mergeSource}
          onSourceChange={setMergeSource}
          index={mergeAt}
          onIndexChange={setMergeIndex}
          preview={mergePreview}
          onPreviewChange={setMergePreview}
        />
      )}
      <div className="app-body">
        <div
          className="app-editor"
          ref={editorRef}
          onKeyDownCapture={(e) => {
            if (e.metaKey || e.ctrlKey) {
              // Cmd+Z / Cmd+Shift+Z reaching the editor directly (not via the
              // app menu accelerator) also change the document.
              if (e.key.toLowerCase() === "z") markDirty();
              return;
            }
            if (e.key.length === 1 || EDIT_KEYS.has(e.key)) markDirty();
          }}
          onPasteCapture={markDirty}
          onCutCapture={markDirty}
          onDropCapture={markDirty}
        >
          <DocxView
            {...view}
            editable
            zoom={zoom}
            onReady={setApi}
            mergeRecord={mergeRecord}
            style={{ height: "100%" }}
          />
          {api && (
            <WordCount
              api={api}
              observeEl={docRoot}
              open={wordCountOpen}
              onOpenChange={setWordCountOpen}
            />
          )}
        </div>
        {panelOpen && api && (
          <AiPanel
            agentDoc={agentDoc}
            api={api}
            settings={settings}
            onOpenSettings={() => setSettingsOpen(true)}
            onEdited={markDirty}
          />
        )}
      </div>
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={setSettings} />
      )}
    </div>
  );
}
