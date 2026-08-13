<div align="center">

# LikeOffice

**A desktop word processor that opens, edits, and saves `.docx` files with page-accurate fidelity to Microsoft Word — with an AI assistant whose every edit arrives as a tracked change you accept or reject.**

[![CI](https://github.com/theRealestAEP/likeoffice/actions/workflows/ci.yml/badge.svg)](https://github.com/theRealestAEP/likeoffice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#download)
[![Rendering parity](https://img.shields.io/badge/rendering%20parity-0.029%25%20mean-brightgreen.svg)](#fidelity)
[![Tests](https://img.shields.io/badge/tests-2%2C761%20passing-brightgreen.svg)](#how-it-is-tested)

</div>

---

## What it is

LikeOffice is a free, open-source word processor. It runs on your computer. It
reads and writes the same `.docx` files that Microsoft Word reads and writes.

Two things make it different from other Word-compatible editors:

1. **It measures its own fidelity.** Every page it draws is compared against
   the same page drawn by desktop Microsoft Word. The numbers are in
   [Fidelity](#fidelity), and they are re-measured on every engine change.
2. **The AI edits are reviewable.** The assistant does not rewrite your
   document behind your back. It records each text change as a tracked change.
   You accept or reject each one.

## Download

> [!NOTE]
> No release is published yet. Until the first release, use
> [Build from source](#build-from-source).

When a release is available, get the installer for your system:

| System | File | Notes |
| --- | --- | --- |
| macOS (Apple silicon) | `LikeOffice-<version>-arm64.dmg` | See [First launch on macOS](#first-launch-on-macos) |
| macOS (Intel) | `LikeOffice-<version>.dmg` | See [First launch on macOS](#first-launch-on-macos) |
| Windows | `LikeOffice Setup <version>.exe` | See [First launch on Windows](#first-launch-on-windows) |
| Linux | the `.AppImage` or `.deb` for your architecture | Make the AppImage executable before you run it |

Each download is about 185-195 MB, and the installed app is about 555 MB.
Two things account for that size: an Electron app carries its own browser
engine, and LikeOffice bundles the Claude command-line tool, which is 277 MB
on its own.

All builds are on the [Releases page](https://github.com/theRealestAEP/likeoffice/releases).

### First launch on macOS

The macOS builds are not signed with an Apple Developer certificate. macOS
therefore blocks the app the first time you open it. This dialog appears:

> **"LikeOffice" Not Opened**
> Apple could not verify "LikeOffice" is free of malware that may harm your
> Mac or compromise your privacy.
> \[Done]  \[Move to Trash]

Select **Done**. Do not select Move to Trash.

To open the app:

1. Move `LikeOffice.app` to your Applications folder.
2. Open the Terminal app.
3. Run this command:

```bash
xattr -d -r com.apple.quarantine /Applications/LikeOffice.app
```

4. Open the app as usual.

The command removes the quarantine flag that macOS adds to every download. You
run it once. Later launches need no extra steps.

> [!NOTE]
> On macOS 15 a Control-click on the app icon does **not** get past this
> dialog, and neither does the Open Anyway button in System Settings in our
> testing. The command above is the step we tested on the released build.
> Signing the app removes this step completely, and it is planned.

### First launch on Windows

The Windows builds are also unsigned. Windows SmartScreen shows a blue dialog
that reads "Windows protected your PC".

To open the app:

1. Select **More info**.
2. Select **Run anyway**.

### Why the warnings appear

A signed app costs money each year: an Apple Developer account for macOS, and
a separate certificate for Windows. This project is not signed yet. The
warnings say that the publisher is unverified. They do not say that the app is
unsafe.

You can check the code yourself. You can also
[build from source](#build-from-source) instead of using a download.

### Updates

Select **Check for Updates…** to look for a new version. The menu item is in
the LikeOffice menu on macOS, and in the File menu on Windows and Linux.
Nothing downloads or installs until you agree.

> [!IMPORTANT]
> On macOS the app can find a new version but cannot install it, because the
> app is unsigned. Download the new `.dmg` from the Releases page instead.
> Windows and Linux install updates normally.

## What it does today

| Area | Status |
| --- | --- |
| Open, edit, save, and print `.docx` | Works |
| Export to PDF | Works |
| Autosave and crash recovery | Works |
| Tracked changes, comments, and review | Works |
| Tables, lists, styles, headers, footers, and footnotes | Works |
| Images, shapes, charts, SmartArt, and equations | Works |
| Find, replace, and go to | Works |
| Mail merge | Preview works; **Finish & Merge** is not built |
| Compare documents | Works |
| Real-time collaboration | In the engine, but the desktop app has no surface for it yet |

The full feature-by-feature audit is in
[`docs/tool-depth-matrix.md`](https://github.com/theRealestAEP/wordinweb/blob/likeoffice/docs/tool-depth-matrix.md).
It lists 138 Word features and grades each one.

## The AI assistant

The assistant reads your document as numbered lines of plain text. It then
sends back a patch against those lines. This keeps a simple edit simple: a
text-only request needs no round trip to inspect formatting.

Three points matter:

- **Every text edit is a tracked change.** Accept or reject each one from the
  Review controls.
- **You choose the model provider.** The app supports the Anthropic API, a
  Claude subscription, and a Codex subscription.
- **Your document stays on your computer**, except for the text the assistant
  needs to read to answer you.

Structural inserts — tables, images, charts, and shapes — have no tracked form
in the file format. The assistant applies those directly. It tells you when it
does.

## Fidelity

LikeOffice draws each page, and desktop Microsoft Word draws the same page.
A metric then compares the two images and reports the difference.

Measured at engine `bb8bd58` over 1,359 pages:

| Measurement | Whole corpus | Real-world documents only |
| --- | --- | --- |
| Pages | 1,359 | 1,007 |
| Mean difference | **0.029%** | **0.0019%** |
| Pages that match exactly | 94.63% | 97.52% |
| Worst page | 2.87% | 0.42% |
| Pages above 1% | 13 | **0** |

Every page above 1% is a synthetic test page, not a real document. No
real-world page in the corpus differs by more than 0.42%.

The corpus holds real Word files: legal contracts, medical protocols,
scientific papers, government templates, and right-to-left documents. The
method, the metric, and every past measurement are recorded in
[the parity method notes](https://github.com/theRealestAEP/wordinweb-parity).

## How it is tested

| Suite | Tests | What it covers |
| --- | --- | --- |
| Engine core | 1,335 | Parsing, layout, rendering, and editing |
| Collaboration | 592 | Operation ordering and byte convergence (engine only) |
| React surface | 702 | Toolbar, view, and editing behaviour |
| Agent | 132 | Tool schemas, patching, and transactions |
| End-to-end | 51 | The packaged Electron app under Playwright |

The rendering corpus above runs as a separate gate. Unit tests do not measure
pixels, so a green suite never stands in for a corpus run.

## Build from source

You need [Node.js](https://nodejs.org/) 22 or later and `git`.

LikeOffice uses a document engine that lives in a second repository. Clone
both repositories side by side.

```bash
# 1. Clone the engine, on the likeoffice branch, into a sibling directory.
git clone -b likeoffice https://github.com/theRealestAEP/wordinweb.git wordinweb-likeoffice
cd wordinweb-likeoffice
npm ci
npm run build
cd ..

# 2. Clone and start the app.
git clone https://github.com/theRealestAEP/likeoffice.git
cd likeoffice
npm install
npm run dev
```

To build an installer for your own system:

```bash
cd apps/desktop
npm run dist:mac     # or dist:win, or dist:linux
```

The installer lands in `apps/desktop/release/`.

## How the repositories fit together

| Repository | Contents |
| --- | --- |
| [likeoffice](https://github.com/theRealestAEP/likeoffice) | The desktop app: Electron shell, menus, AI panel, and installers |
| [wordinweb](https://github.com/theRealestAEP/wordinweb) | The document engine: parsing, layout, rendering, and editing |
| [wordinweb-parity](https://github.com/theRealestAEP/wordinweb-parity) | The fidelity harness: fixtures, metric, and measurements |

Engine work happens on the `likeoffice` branch of `wordinweb`. It merges back
to `main` in small reviewed steps.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | Workstreams, milestones, and metrics |
| [docs/architecture.md](docs/architecture.md) | Electron shell design and integration points |
| [docs/agent-ir.md](docs/agent-ir.md) | The text representation the AI edits against |
| [docs/inflight-and-agent-roadmap.md](docs/inflight-and-agent-roadmap.md) | What is open, what is done, and what is unverified |
| [docs/known-issues.md](docs/known-issues.md) | Known problems, with the evidence |
| [RELEASING.md](RELEASING.md) | How to cut a release |

## Contributing

Issues and pull requests are welcome.

Please run the tests before you open a pull request. If you change anything
under `layout`, `render`, or `parse` in the engine, run the rendering corpus
as well. A green unit suite does not prove that a page still draws correctly.

## License

MIT. See [LICENSE](LICENSE).
