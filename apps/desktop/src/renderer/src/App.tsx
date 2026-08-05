import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DocxView,
  DocxToolbar,
  useAgentDocumentSession,
  type AgentDocumentViewBinding,
  type DocxViewApi,
} from "wordinweb";
import { AgentDocument, LocalDocumentSession, localDocumentViewBinding } from "@wordinweb/agent";
import { AiPanel } from "./AiPanel";
import { SettingsDialog } from "./SettingsDialog";

const EDIT_KEYS = new Set(["Enter", "Backspace", "Delete", "Tab"]);

export function App() {
  const [doc, setDoc] = useState<InitialDocument | null>(null);

  useEffect(() => {
    void window.likeoffice
      .getInitialDocument()
      .then((d) => setDoc({ ...d, bytes: new Uint8Array(d.bytes) }));
  }, []);

  if (!doc) return null;
  return <Editor initial={doc} />;
}

function Editor({ initial }: { initial: InitialDocument }) {
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
  const [dirty, setDirty] = useState(initial.recovered);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsView>({ hasKey: false, model: "" });
  const apiRef = useRef<DocxViewApi | null>(null);
  apiRef.current = api;

  useEffect(() => {
    void window.likeoffice.getSettings().then(setSettings);
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
      switch (action) {
        case "save":
          void save(false);
          break;
        case "save-as":
          void save(true);
          break;
        case "print":
          a?.print();
          break;
        case "export-pdf": {
          const html = a?.exportPrintHtml();
          if (html) void window.likeoffice.exportPdf(html);
          break;
        }
        case "undo":
          a?.undo();
          break;
        case "redo":
          a?.redo();
          break;
        case "settings":
          setSettingsOpen(true);
          break;
        case "toggle-ai":
          setPanelOpen((open) => !open);
          break;
      }
    });
  }, [save]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Dirty tracking is heuristic until the engine grows a change event:
            any editing keystroke or toolbar interaction marks the document dirty. */}
        <div style={{ flex: 1, minWidth: 0 }} onMouseDownCapture={markDirty}>
          {api && <DocxToolbar api={api} mode="advanced" />}
        </div>
        <button
          onClick={() => setPanelOpen((open) => !open)}
          style={{ marginRight: 8 }}
          data-testid="ai-toggle"
        >
          AI
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div
          style={{ flex: 1, minWidth: 0 }}
          onKeyDownCapture={(e) => {
            if (e.metaKey || e.ctrlKey) return;
            if (e.key.length === 1 || EDIT_KEYS.has(e.key)) markDirty();
          }}
          onPasteCapture={markDirty}
          onCutCapture={markDirty}
          onDropCapture={markDirty}
        >
          <DocxView {...view} editable onReady={setApi} style={{ height: "100%" }} />
        </div>
        {panelOpen && api && (
          <AiPanel
            agentDoc={agentDoc}
            api={api}
            hasKey={settings.hasKey}
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
