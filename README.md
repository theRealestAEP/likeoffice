# LikeOffice

An open-source desktop word processor. MIT licensed. Built on
[wordinweb](https://github.com/theRealestAEP/wordinweb).

LikeOffice is an Electron app with three goals:

1. **Full editing parity with Microsoft Word.** Open, edit, and save `.docx`
   with page-accurate fidelity. The rendering engine already matches desktop
   Word at a mean structural severity of 0.358% across 1,188 measured pages.
   The editing surface will grow to match the full Word ribbon.
2. **Handle thousands of pages.** Memory and latency budgets are enforced by
   benchmarks. Target: open and edit a 5,000-page document with bounded heap
   and sub-25ms keystrokes.
3. **A Cursor-grade AI editing experience.** Agents get a schema-enforced tool
   surface, a text-only intermediate representation ("DocMD") for fast bulk
   edits without formatting exposure, and every agent edit lands as a
   reviewable tracked change.

## Status

M0 complete; M1 in progress. The full plan lives in
[`docs/PLAN.md`](docs/PLAN.md).

Working today: the Electron app opens, edits, saves, prints, and exports
PDFs, with autosave + crash recovery and a Playwright-Electron e2e suite. A
side panel runs the wordinweb agent tools over the open document; every agent
edit lands as a tracked change you accept or reject from the review controls.
The W0 edit round-trip gate (wordinweb-parity, branch `edit-roundtrip`)
passes 10/10 scenarios against desktop Word. The engine branch
(`wordinweb-likeoffice`, branch `likeoffice`) carries the operation
registry and the first Word-calibrated fidelity fixes.

| Doc | Contents |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | Master plan: workstreams, milestones, metrics, risks |
| [docs/current-state.md](docs/current-state.md) | Audit of wordinweb + wordinweb-parity as of 2026-08-05 |
| [docs/architecture.md](docs/architecture.md) | Electron shell design and integration seams |
| [docs/wordinweb-expansion.md](docs/wordinweb-expansion.md) | Editing-parity workstream in the wordinweb branch |
| [docs/memory.md](docs/memory.md) | Thousands-of-pages memory and latency plan |
| [docs/agent-ir.md](docs/agent-ir.md) | DocMD text IR and the Cursor-like agent UX |
| [docs/parity-coverage.md](docs/parity-coverage.md) | Fixture corpus expansion and the edit round-trip gate |

## Relationship to wordinweb

LikeOffice is the desktop shell. The document engine stays in the `wordinweb`
repo. All engine work happens on the `likeoffice` branch of wordinweb (checked
out at `../wordinweb-likeoffice`) and merges back to wordinweb `main` in small
reviewed increments. LikeOffice consumes the engine as a workspace link during
development and as pinned npm versions at release.

## License

MIT. See [LICENSE](LICENSE).
