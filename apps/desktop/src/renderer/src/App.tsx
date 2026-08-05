import { useCallback, useEffect, useRef, useState } from "react";
import { DocxView, DocxToolbar, type DocxViewApi } from "wordinweb";

const EDIT_KEYS = new Set(["Enter", "Backspace", "Delete", "Tab"]);

export function App() {
  const [doc, setDoc] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [api, setApi] = useState<DocxViewApi | null>(null);
  const [dirty, setDirty] = useState(false);
  const apiRef = useRef<DocxViewApi | null>(null);
  apiRef.current = api;

  useEffect(() => {
    void window.likeoffice.getInitialDocument().then((d) => {
      setDoc({ name: d.name, bytes: new Uint8Array(d.bytes) });
      if (d.recovered) setDirty(true);
    });
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
    document.title = `${dirty ? "• " : ""}${doc?.name ?? "LikeOffice"} — LikeOffice`;
    window.likeoffice.setDirty(dirty);
  }, [dirty, doc?.name]);

  const markDirty = useCallback(() => setDirty(true), []);

  const save = useCallback(async (saveAs: boolean) => {
    const a = apiRef.current;
    if (!a) return;
    const bytes = a.save();
    const result = await window.likeoffice.saveDocument(bytes, saveAs);
    if (result) {
      setDoc((d) => (d ? { ...d, name: result.name } : d));
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
        case "undo":
          a?.undo();
          break;
        case "redo":
          a?.redo();
          break;
      }
    });
  }, [save]);

  if (!doc) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Dirty tracking is heuristic until the engine grows a change event:
          any editing keystroke or toolbar interaction marks the document dirty. */}
      <div onMouseDownCapture={markDirty}>
        {api && <DocxToolbar api={api} mode="advanced" />}
      </div>
      <div
        style={{ flex: 1, minHeight: 0 }}
        onKeyDownCapture={(e) => {
          if (e.metaKey || e.ctrlKey) return;
          if (e.key.length === 1 || EDIT_KEYS.has(e.key)) markDirty();
        }}
        onPasteCapture={markDirty}
        onCutCapture={markDirty}
        onDropCapture={markDirty}
      >
        <DocxView
          source={doc.bytes}
          editable
          onReady={setApi}
          style={{ height: "100%" }}
        />
      </div>
    </div>
  );
}
