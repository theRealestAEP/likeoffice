# Releasing LikeOffice

## How a release works

1. Bump `version` in `apps/desktop/package.json`.
2. Commit, then tag the commit `v<version>` (for example `v0.1.0`) and push the tag.
3. The `Release` workflow (`.github/workflows/release.yml`) builds installers on macOS, Windows, and Linux. It uploads them to a **draft** GitHub Release.
4. Download and smoke-test the installers, then publish the draft. Auto-update only sees published releases.

The workflow clones `theRealestAEP/wordinweb` as a sibling directory and builds it first. The app's `file:` dependencies resolve into that clone, which mirrors the local development layout.

### How to smoke-test the draft

Test the artifact you are about to publish, not a local build of the same
commit. Both defects found while cutting 0.1.0 — a bundle macOS called
"damaged", and an Intel build carrying an arm64 helper — existed only in the
packaged output. A green build proves neither.

Download the `.dmg` from the draft, mount it, copy the app out, and check:

```bash
codesign --verify --deep --strict LikeOffice.app   # must pass, adhoc is fine
file LikeOffice.app/Contents/MacOS/LikeOffice      # must match the artifact's arch
find LikeOffice.app -name claude -exec file {} \;  # must match it too
```

Then open a document, type, and save, and confirm the saved file is a valid
zip whose `document.xml` holds the typed text.

Drive that with **Playwright**, pointing `executablePath` at the copied binary
and sending menu actions through `app.evaluate` from the main process — the
same way `e2e/` already works. It takes about a second. Do NOT drive it with
AppleScript: `activate` loses to whatever app holds focus, a binary launched
outside LaunchServices cannot be activated by name, and `System Events` reports
zero windows for a perfectly healthy app. All three wasted time during 0.1.0.

### Verify the effect, not the mechanism

Every defect that survived a review this far had the same shape: the
**mechanism** was correct and the **effect** was absent. None of them is
visible in a diff, and none of them survives one measurement.

| The mechanism looked right | The effect was absent |
| --- | --- |
| The bundle carried a signature | It sealed a bundle that had since been rewritten, so macOS called it "damaged" |
| `electron-builder --mac --arm64` named an arch | A config `arch:` list overrode the flag and built x64 too |
| `npm install` fetched the agent binary | It fetched the one for the BUILD host, so the Intel dmg carried an arm64 helper |
| `appearance: textfield` read back as applied | Chrome ignores it; the spinner arrows still painted |
| A CSS rule set `border-color` on focus | An inline `border` shorthand outranked it, so it never applied |
| A focus ring was drawn in the theme's own blue | At 1.15:1 against the field it was a ring nobody could see |
| The harness dispatched the event to the element | Real hit-testing never targets a `pointer-events: none` element, so the test could not fail |
| Every popover's rect was measured in a browser and sat inside the window | A rewrite script had matched the STYLE BLOCK, not the tag, so five panels never got their `ref` — and a rect assertion cannot see a height that was never measured |

So before calling any of these done:

1. Measure the thing the user experiences, not the thing you set.
2. Compare against a control — the same page without the change, side by side.
3. Prefer a number to an impression. Contrast ratios and `file` output do not
   flatter you; a screenshot at a glance does.

The cheapest of these checks took about ninety seconds. Each one stood between
a change that reads as finished and a change that works.

#### Measuring the right effect is not the same as measuring enough of them

The last row is a sharper version of the rule, and it cost a shipped defect to
learn. The measurement was real, taken in a real browser, and correct: those
panels' right edges genuinely were inside the window. But the horizontal clamp
came from a `width` passed in code, while the flip and the height cap came from
a height read off the panel's `ref` — and the five panels with no `ref` had no
height at all. One effect was right, a second effect was dead, and the first
could not reveal the second. It surfaced only when Escape had to hand focus
back, because that is the first behaviour that genuinely needs the `ref`.

So: **"verify the effect" assumes you know which effect to look at.** When a
change has two consequences, measuring the obvious one is not evidence about
the other.

The mechanical half of this is worth stating on its own, because it generalises
past this file:

> A codemod-style edit must be checked by COUNTING the sites that took it, not
> by sampling a few. Sampling five of twenty-nine call sites would have passed.
> Re-grep for the shape you rewrote and assert the count is what you expect —
> the sites a pattern silently skips are exactly the ones whose formatting made
> them different, and different formatting is not correlated with being less
> important.

#### The last row is about our tests, not our code

`element.dispatchEvent(...)` makes that element the event target **whatever
its `pointer-events` are**. So a test that dispatches to the node it expects
to win cannot observe a hit-testing failure — the class of bug where the
right handler exists and the browser never routes anything to it.

That is not one bug's footnote. **Every test we have that dispatches events
directly is blind to that entire class.** It is how a 3D model shipped that
could be neither selected nor rotated while its unit tests stayed green:
they dispatched to the `<model-viewer>` that a real press can never reach.

When a change touches what the browser can hit — `pointer-events`, overlays,
z-order, element replacement — drive it with **real input** (Playwright's
mouse) or at least `elementFromPoint`, and never with `dispatchEvent` on the
node you expect to win. And make the test use the control **twice**: a
gesture that works once and then dies passes every single-use test.
`e2e/drawing-drag.spec.ts` is the worked example of both.

### Pin the engine before you tag

`release.yml` reads `.engine-ref` at the repo root: one line, a full 40-character engine commit sha. The tagged build then checks the engine out at exactly that commit, so the release can be rebuilt byte-for-byte later.

With no such file the build falls back to the tip of `wordinweb@likeoffice`, prints a `::warning::` saying the release is **not reproducible**, and records the resolved sha in the job summary. Nothing breaks, but the tag no longer identifies what was built.

The order for a release is therefore:

1. Push the engine commits to `theRealestAEP/wordinweb` branch `likeoffice`.
2. Write that engine sha into `.engine-ref` here and commit it.
3. Bump the version, tag, push the tag.

Step 1 comes first because CI clones the engine from GitHub: an engine commit that is only local will not be in the build.

## Two release channels

| Channel | Trigger | Tag | Marked |
| --- | --- | --- | --- |
| Stable | pushing a `v*` tag | `v<version>` | draft, published by hand |
| Main builds | every push to `main` | `nightly`, replaced in place | prerelease |

`main-build.yml` keeps exactly one rolling prerelease so the releases page does not accumulate one entry per commit. It skips doc-only pushes and cancels superseded runs.

The two channels cannot cross. With a stable version installed, `electron-updater` sets `allowPrerelease = false` and resolves updates through GitHub's `/releases/latest`, which excludes prereleases, then reads the channel file from under that tag — so a nightly is never offered to someone running a release. Each channel's `latest*.yml` lives under its own tag and they never meet.

## Local builds

- `npm run dist:mac` — dmg + zip for **this machine's architecture** (run on macOS)
- `npm run dist:win` — NSIS installer (run on Windows)
- `npm run dist:linux` — AppImage + deb (run on Linux)

A local mac build produces one architecture on purpose. Pass `--arm64` or
`--x64` to `electron-builder` to choose, but note that building an arch on a
host of a different arch **fails the build** — see Architecture below.

Output lands in `apps/desktop/release/`. Local builds never publish (`--publish never`).

The engine must be built first: run `npm run build` in the sibling `wordinweb-likeoffice` clone, then `npm install` here.

## Packaging model

The installers ship the electron-vite output (`apps/desktop/out/`), `resources/`, and the runtime dependencies of the main process. The `files` allowlist in `electron-builder.yml` names only `out/**` and `resources/**`, but electron-builder collects the production dependency tree separately, so all six runtime dependencies are packed:

| Package | Why it is needed at runtime |
| --- | --- |
| `@anthropic-ai/sdk` | Anthropic API calls |
| `@anthropic-ai/claude-agent-sdk` | Claude subscription provider |
| `@modelcontextprotocol/sdk` | MCP server for the agent tools |
| `electron-updater` | Check for Updates… |
| `nspell` | Spell checking |
| `papaparse` | CSV parsing for mail merge |

The renderer bundle is self-contained: Vite inlines the engine packages (`wordinweb`, `@wordinweb/agent`), so they sit in `devDependencies` and never reach the asar. `.docx` files are registered for open-with on all three platforms.

The app icon is a generated placeholder at `apps/desktop/build/icon.png`. electron-builder derives the icns/ico variants from it. Replace the png to change the icon.

### Download size

Measured for 0.0.1, in decimal MB — what Finder and the GitHub download page show:

| Artifact | Size |
| --- | --- |
| `LikeOffice-<version>-arm64.dmg` | 184.7 MB |
| `LikeOffice-<version>-arm64-mac.zip` | 186.0 MB |
| `LikeOffice-<version>.dmg` (Intel) | 191.0 MB |
| `LikeOffice-<version>-mac.zip` (Intel) | 192.3 MB |
| Installed `LikeOffice.app` | 555 MB |

**277 MB of that 555 MB installed bundle is a single file**: the `claude`
native executable inside `@anthropic-ai/claude-agent-sdk-<platform>`, unpacked
beside the asar because executables cannot run from inside one. Electron's own
framework accounts for most of the rest. Any serious attempt to shrink the
download starts with that binary — not with the app code, which is a few MB.

### Architecture

macOS artifacts must be built on a runner of their own architecture, and CI
does this with two matrix legs: `macos-latest` (Apple silicon, macOS 26 arm64)
and `macos-15-intel` (x86_64).

Not `macos-13` — that label is retired. GitHub names `macos-15-intel` the
**last x86_64 Actions image**, available until **August 2027**. After that
there is no GitHub-hosted way to build an Intel mac artifact, and the Intel
download will have to come from a self-hosted runner, a cross-build with the
right optional dependency installed by hand, or be dropped.

The reason is `@anthropic-ai/claude-agent-sdk`, which ships its executable in
eight platform-specific `optionalDependencies`. npm installs only the one
matching the **build host**, and electron-builder packs whatever is in
`node_modules` regardless of the `--arch` it was given. Building both arches on
one Apple Silicon machine therefore produced an Intel dmg carrying an **arm64**
binary: the app opened, and every agent feature was dead on an Intel Mac.

`build/verify-arch.cjs` runs from the `afterPack` hook and fails the build if
any Mach-O in the bundle is the wrong CPU. It runs before any dmg exists, so a
mismatched build cannot be produced, let alone published.

For the same reason `mac.target` in `electron-builder.yml` carries **no**
`arch:` list: pinning it there overrides the CLI flag, so `--mac --arm64` would
still try to build x64 as well.

### Ad-hoc signing (macOS)

`build/after-pack.cjs` ad-hoc signs the mac bundle and fails the build if the
seal does not verify. This is not optional cosmetics. electron-builder rewrites
the bundle after unpacking Electron and then, with no Developer ID, skips
signing entirely — leaving Electron's own linker signature over a bundle that
no longer matches it (`Identifier=Electron`, `Sealed Resources=none`, no
`Contents/_CodeSignature`). macOS reads that as **corrupt**, not unsigned, and
a downloaded copy shows:

> "LikeOffice" is damaged and can't be opened. You should move it to the Trash.

That dialog has no override, so Control-click > Open cannot rescue it. With the
ad-hoc signature the same download shows the ordinary unidentified-developer
refusal, which the user can get past. A real Developer ID signature replaces
the ad-hoc one: `afterPack` runs before electron-builder's own signing step.

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

### The current decision: unsigned

Releases are unsigned for now. Signing is a follow-up, not a rejected idea.
The reasoning: a certificate costs money each year, and the project does not
yet know whether people want the app. The workflow already passes the signing
secrets through when they exist, so turning signing on later means adding the
secrets and setting `notarize: true`. No code has to change.

Two costs come with that choice. Users see a warning on first launch, on macOS
and on Windows both — the README tells them what the warning says and what to
do. And macOS auto-update can CHECK for a new version but cannot install it,
because `electron-updater` only installs into a signed app. Mac users must
therefore download each new version by hand until signing is enabled.
