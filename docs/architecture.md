# LikeOffice Electron architecture (W1)

## Process model

- **Main process**: window management, native menus, file dialogs, recent
  files, print, font access, the filesystem bundle store, autosave, crash
  recovery, deep links, and (optional) an embedded `CollabHub`.
- **Preload**: a typed, contextIsolated IPC bridge. `nodeIntegration` off,
  renderer sandboxed.
- **Renderer**: the React app — `DocxView` + `DocxToolbar` + LikeOffice chrome
  (start screen, AI panel, document stats).

**One document per `BrowserWindow`** (the Word model). Each document gets its
own renderer process, which isolates the large layout heap per document,
contains crashes, and lets the OS reclaim a closed document's memory
immediately. Each window mints its own collab `clientId` (the web app's
per-tab sessionStorage semantics carry over directly).

## App identity

- App: `LikeOffice`. Bundle id `io.likeoffice.app`.
- Stack: Electron + Vite + React + TypeScript. electron-builder for packages.
- Custom protocol `likeoffice://` registered as secure (required: the
  renderer must remain a secure context so `crypto.subtle` exists for E2EE)
  and as the deep-link handler for collab invites (later milestone).

## File I/O

The engine is already host-owned for files: `DocxView` takes bytes;
`api.save()` returns bytes. Replacements:

| Web today | LikeOffice |
| --- | --- |
| Hidden `<input type=file>` open | `dialog.showOpenDialog` via IPC |
| 5 duplicated Blob-download call sites | One `saveDocument` IPC helper: atomic write (temp file + rename), `dialog.showSaveDialog` for Save As |
| Toolbar's 4 embedded file inputs (image, SVG, GLB, OLE) | Keep as-is initially (they work in Electron); replace with native dialogs behind a toolbar host hook later |
| `<a download>` for versions | Native save dialog |

First engineering task: consolidate the five download call sites into one
helper (upstream, in wordinweb) so the desktop swap is one seam.

## Persistence and autosave

- Implement `FileBundleStore` (the 4-method `BundleStore` interface) in the
  main process, storing `DocBundle`s under
  `app.getPath("userData")/documents/`. The bundle (confirmed bytes +
  stable-id sidecar + pending + offline tail) is the crash-safe working copy;
  the user's `.docx` on disk is written only on explicit Save.
- Port the reference app's retention logic (`version-retention.ts`,
  `startup-reclaim.ts`) with real disk-usage numbers replacing
  `navigator.storage.estimate()` and its wrong-for-desktop fallbacks.
- Autosave flush moves from `pagehide`/`visibilitychange` to
  `close`/`before-quit`, plus a throttled timer (the engine's
  `BundlePersister` throttle already exists).
- On launch, offer recovery for bundles newer than their `.docx`.

## Clipboard

- The engine's native `copy`/`cut`/`paste` events work unchanged.
- The context-menu path uses permission-gated `navigator.clipboard`; route it
  through Electron's `clipboard` module via the preload bridge.
- W2's OOXML clipboard flavor lands upstream; on desktop, also register the
  native Word clipboard formats so paste from/to desktop Word carries full
  fidelity.

## Print

Replace the hidden-iframe `document.write` path with
`webContents.printToPDF`/`print()`. The renderer already exposes
`materializeAll()` to mount all virtualized pages for capture; call it, print,
restore.

## Fonts

- Enumerate installed system fonts (replaces the fixed 35-family probe list —
  upstream toolbar change).
- When real Office fonts exist on the OS (Calibri, Cambria, DokChampa, …),
  paint uses them natively and `onMissingFonts` goes quiet; metric substitutes
  remain the layout fallback. This closes the Thai 3.95%/Tamil 1.30% floors.
- Never bundle licensed fonts in releases.

## Collab and agents in the desktop app

- **Local agent sessions** (the Cursor experience) run against the in-process
  document via the existing `LocalDocumentSession` binding — a server is
  unnecessary for the single-user case.
- **Live share** (later): embed `CollabHub` directly in the main process
  (construct it; drive `hub.handle(conn, msg)`; run the four sweep timers;
  avoid `startZeroCustodyServer`, which installs a `process.exit`
  uncaughtException handler). The renderer connects over an IPC
  `ClientTransport` — two methods, and it **must answer `ping` with a
  nonce-echoing `pong`** or `LivenessMonitor` declares the link dead. Joining
  remote rooms uses the existing WebSocket transport unchanged.
- Upstream fix needed: `MAX_ROOM_CLIENTS` reads env at class-definition time;
  make it part of `HubLimits` so it is injectable.

## Menus, routing, lifecycle

- Native menu bar mirrors the ribbon's command set through `DocxViewApi`;
  the File menu replaces the web app's DOM File menu.
- The web app's router is five `history.replaceState` sites and
  `?doc=`/`#k=` params; in LikeOffice this becomes app state in main +
  deep-link parsing. The three `location.reload()` recovery buttons become
  window reloads.
- Keep the codebase's deliberate avoidance of `window.prompt`/`confirm`
  (they stall the socket pump); use in-UI two-step confirmations.

## Repo layout

```
likeoffice/
  apps/desktop/          # Electron main + preload + renderer
    src/main/            # main process
    src/preload/
    src/renderer/        # React app
  packages/
    bundle-store-fs/     # FileBundleStore (BundleStore impl)
    ipc-transport/       # ClientTransport over Electron IPC
  docs/
  e2e/                   # Playwright + electron
```

Engine packages come from `../wordinweb-likeoffice` via `file:` links during
development; releases pin published versions.
