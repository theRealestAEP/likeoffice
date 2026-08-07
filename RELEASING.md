# Releasing LikeOffice

## How a release works

1. Bump `version` in `apps/desktop/package.json`.
2. Commit, then tag the commit `v<version>` (for example `v0.1.0`) and push the tag.
3. The `Release` workflow (`.github/workflows/release.yml`) builds installers on macOS, Windows, and Linux. It uploads them to a **draft** GitHub Release.
4. Download and smoke-test the installers, then publish the draft. Auto-update only sees published releases.

The workflow clones `theRealestAEP/wordinweb` at branch `likeoffice` as a sibling directory and builds it first. The app's `file:` dependencies resolve into that clone, which mirrors the local development layout.

## Local builds

- `npm run dist:mac` — dmg + zip for arm64 and x64 (run on macOS)
- `npm run dist:win` — NSIS installer (run on Windows)
- `npm run dist:linux` — AppImage + deb (run on Linux)

Output lands in `apps/desktop/release/`. Local builds never publish (`--publish never`).

The engine must be built first: run `npm run build` in the sibling `wordinweb-likeoffice` clone, then `npm install` here.

## Packaging model

The installers ship the electron-vite output (`apps/desktop/out/`), `resources/`, and the runtime dependencies of the main process (`@anthropic-ai/sdk`, `electron-updater`). The renderer bundle is self-contained: Vite inlines the engine packages (`wordinweb`, `@wordinweb/agent`), so they sit in `devDependencies` and never reach the asar. `.docx` files are registered for open-with on all three platforms.

The app icon is a generated placeholder at `apps/desktop/build/icon.png`. electron-builder derives the icns/ico variants from it. Replace the png to change the icon.

## Auto-update

The packaged app checks GitHub Releases with `electron-updater` through the menu item **Check for Updates…** (app menu on macOS, File menu elsewhere). Nothing is automatic: the user confirms the download and the restart. Dev builds hide the menu item.

Note: on macOS, `electron-updater` can only install updates into a **signed** app. Unsigned builds can check for updates but the install step fails.

## Code signing and notarization

CI builds are unsigned by default and need no secrets beyond `GITHUB_TOKEN`. To sign, add repository secrets; the workflow passes them through when present.

macOS:

- `CSC_LINK` — base64 of the Developer ID Application `.p12` certificate
- `CSC_KEY_PASSWORD` — password for that certificate
- Notarization additionally needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, plus `notarize: true` under `mac:` in `apps/desktop/electron-builder.yml` (it is `false` while builds are unsigned).

Windows:

- `CSC_LINK` / `CSC_KEY_PASSWORD` with an Authenticode `.p12` also work here. Cloud HSM signing (Azure Trusted Signing, etc.) needs its own config; see the electron-builder code-signing docs.

Linux builds need no signature.
