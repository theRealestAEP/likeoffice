interface InitialDocument {
  path: string | null;
  name: string;
  bytes: Uint8Array;
  recovered: boolean;
}

interface SaveResult {
  path: string;
  name: string;
}

interface LikeOfficeBridge {
  getInitialDocument(): Promise<InitialDocument>;
  saveDocument(bytes: Uint8Array, saveAs: boolean): Promise<SaveResult | null>;
  setDirty(dirty: boolean): void;
  autosave(bytes: Uint8Array): void;
  exportPdf(html: string): Promise<{ path: string } | null>;
  onMenu(cb: (action: string) => void): () => void;
}

interface Window {
  likeoffice: LikeOfficeBridge;
}
