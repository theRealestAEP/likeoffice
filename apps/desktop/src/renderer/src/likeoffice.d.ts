interface InitialDocument {
  path: string | null;
  name: string;
  bytes: Uint8Array;
}

interface SaveResult {
  path: string;
  name: string;
}

interface LikeOfficeBridge {
  getInitialDocument(): Promise<InitialDocument>;
  saveDocument(bytes: Uint8Array, saveAs: boolean): Promise<SaveResult | null>;
  setDirty(dirty: boolean): void;
  onMenu(cb: (action: string) => void): () => void;
}

interface Window {
  likeoffice: LikeOfficeBridge;
}
