import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { SettingsPage } from "./SettingsPage";
import { attachSpellcheck } from "./spellcheck";
import { WordCount } from "./WordCount";

const EDIT_KEYS = new Set(["Enter", "Backspace", "Delete", "Tab"]);

const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2];

/**
 * What the window shows when it cannot show a document.
 *
 * A file that fails to load or parse used to leave a blank white window with no
 * message — indistinguishable from the app hanging. Reading the file and
 * building the session are separate failures with the same symptom, so both
 * land here.
 */
function LoadFailure({ detail }: { detail: string }) {
  return (
    <div className="app-failure" role="alert">
      <h1 className="app-failure-title">This document could not be opened</h1>
      <p className="app-failure-detail">{detail}</p>
      <p className="app-failure-hint">
        The file may be damaged, or not a Word document. Your other windows are unaffected.
      </p>
    </div>
  );
}

/**
 * Catches a render-time throw from the editor.
 *
 * The document model is built during render; a malformed .docx that survives
 * parsing can still throw while laying out. React unmounts the whole tree on an
 * uncaught error, which is the blank window — this turns it into a message.
 */
class EditorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) return <LoadFailure detail={this.state.error.message} />;
    return this.props.children;
  }
}

export function App() {
  const [doc, setDoc] = useState<InitialDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Revert replaces the document wholesale; a new key remounts the editor onto
  // the reloaded bytes rather than trying to patch the live session.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    void window.likeoffice
      .getInitialDocument()
      .then((d) => setDoc({ ...d, bytes: new Uint8Array(d.bytes) }))
      // Unhandled before: the promise rejected and the window stayed blank.
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  const reload = useCallback((next: InitialDocument) => {
    setDoc({ ...next, bytes: new Uint8Array(next.bytes) });
    setGeneration((n) => n + 1);
  }, []);

  if (loadError) return <LoadFailure detail={loadError} />;
  if (!doc) return null;
  return (
    <EditorBoundary key={generation}>
      <Editor key={generation} initial={doc} onReload={reload} />
    </EditorBoundary>
  );
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
    provider: "anthropic",
    providers: [],
    hasKey: false,
    model: "",
    spellLanguage: "system",
    web: { backend: "direct", searxngUrl: "", hasKey: false, enabled: false },
    storage: { autosave: true, autosaveSeconds: 30, projectsDir: "" },
    s3: {
      enabled: false,
      endpoint: "",
      region: "us-east-1",
      bucket: "",
      prefix: "",
      accessKeyId: "",
      secretAccessKey: "",
      hasSecret: false,
    },
  });
  /** When the document's own file was last written by autosave. */
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The open file changed on disk under us; the user has not answered yet. */
  const [externalChange, setExternalChange] = useState(false);
  /** Bumped by every edit, so an in-flight autosave can tell whether the bytes
   * it wrote are still the whole document. */
  const editGeneration = useRef(0);
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
  // The interval is the user's, not a constant, and the effect re-runs when it
  // changes so a new value takes effect without a restart.
  useEffect(() => {
    const timer = setInterval(() => {
      const a = apiRef.current;
      if (!a || !dirtyRef.current) return;
      setSaving(true);
      // The generation at the moment the bytes were taken. Anything typed while
      // the write is in flight bumps it, and a stale completion must NOT clear
      // the dirty flag over those keystrokes — they are not in the file.
      const takenAt = editGeneration.current;
      void window.likeoffice
        .autosave(a.save())
        .then((at) => {
          setSaveError(null);
          if (!at) return;
          setSavedAt(new Date(at));
          if (editGeneration.current === takenAt) setDirty(false);
        })
        .catch((error: unknown) => {
          // A disk-full or read-only failure used to be swallowed here, leaving
          // the header claiming the document was saved.
          setSaveError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setSaving(false));
    }, Math.max(5, settings.storage.autosaveSeconds) * 1000);
    return () => clearInterval(timer);
  }, [settings.storage.autosaveSeconds]);

  useEffect(() => {
    document.title = `${dirty ? "• " : ""}${name} — LikeOffice`;
    window.likeoffice.setDirty(dirty);
  }, [dirty, name]);

  /**
   * The file changed on disk while it was open here.
   *
   * Reported, never resolved silently. Reloading would throw away edits made
   * here; keeping would throw away whatever the other program wrote at the next
   * save. Both are destructive, so the choice belongs to the person who knows
   * which copy matters.
   */
  useEffect(() => {
    return window.likeoffice.onExternalChange(() => setExternalChange(true));
  }, []);

  const markDirty = useCallback(() => {
    editGeneration.current++;
    setDirty(true);
  }, []);

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

  /**
   * Make the assistant's edits undoable.
   *
   * The agent applies intents straight to the shared DocxDocument, a path the
   * editor never sees — so Cmd+Z could not reach an AI table insert or row
   * deletion, and structural operations have no tracked form to reject either.
   * Revert to Saved was the only way back, and autosave may already have
   * overwritten the file it reverts to. Checkpointing before each applied intent
   * puts AI work on the same undo stack as the user's own.
   */
  useEffect(() => {
    if (!api) return;
    session.onBeforeApply = () => {
      api.checkpoint();
      // AND the document is now modified. This is the AUTHORITATIVE dirty
      // signal: every edit — typed, clicked, dragged, or made by the assistant —
      // reaches the document as an intent through this session, so nothing that
      // changes the document can miss it.
      //
      // The DOM handlers below stay as a belt-and-braces cover for anything that
      // mutates without an intent, but they are a heuristic: they watch for
      // keys, paste, cut, drop and toolbar mousedown, and an image dragged or
      // resized with the mouse fires none of those. That gap meant closing the
      // window offered no save prompt and deleted the recovery copy.
      markDirty();
    };
    return () => {
      session.onBeforeApply = null;
    };
  }, [api, session, markDirty]);

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
          {/* Autosave has to be VISIBLE or it is indistinguishable from not
              running — which is exactly how it read before this existed. */}
          <span className={`save-status${saveError ? " save-status-error" : ""}`} data-testid="save-status">
            {/* ORDER MATTERS. An earlier version checked savedAt first, so once
                anything had ever been saved the header read "Saved 12:04"
                forever — through later edits, and through every failed save
                after it. The only indicator of what is on disk must never be
                more optimistic than the document's actual state. */}
            {saveError
              ? `Could not save: ${saveError}`
              : saving
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : savedAt
                    ? `Saved ${savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : ""}
          </span>
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
      {externalChange && (
        <div className="app-banner" role="alert" data-testid="external-change">
          <span>
            This file was changed by another program.{" "}
            {dirty ? "Reloading will discard your unsaved changes here." : ""}
          </span>
          <span className="app-banner-actions">
            <button
              className="btn btn-ghost"
              onClick={() => {
                setExternalChange(false);
                void window.likeoffice.revertDocument().then((next) => {
                  if (next) onReload(next);
                });
              }}
              data-testid="external-reload"
            >
              Reload from disk
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                // Keeping this copy means the next save overwrites theirs, so
                // the document is treated as modified from here on.
                setExternalChange(false);
                markDirty();
              }}
              data-testid="external-keep"
            >
              Keep mine
            </button>
          </span>
        </div>
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
        {/* HIDDEN, NOT UNMOUNTED. Closing the panel used to destroy it, which
            wiped the whole conversation and — through the unmount cleanup —
            CANCELLED a run in progress. Cmd+Shift+A is bound to this toggle, so
            one stray keystroke mid-answer threw away both the answer and the
            history that led to it, silently. Keeping it mounted costs a hidden
            subtree and keeps the transcript for the length of the session. */}
        {api && (
          <div className="ai-dock" hidden={!panelOpen} aria-hidden={!panelOpen}>
            <AiPanel
              agentDoc={agentDoc}
              api={api}
              settings={settings}
              onOpenSettings={() => setSettingsOpen(true)}
              onSettingsChanged={setSettings}
              onEdited={markDirty}
            />
          </div>
        )}
      </div>
      {settingsOpen && (
        <SettingsPage onClose={() => setSettingsOpen(false)} onSaved={setSettings} />
      )}
    </div>
  );
}
