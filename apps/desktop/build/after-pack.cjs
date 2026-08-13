"use strict";

/**
 * Ad-hoc sign the macOS bundle so an unsigned download is merely UNTRUSTED
 * rather than BROKEN.
 *
 * electron-builder rewrites the bundle after unpacking Electron — it inserts
 * app.asar, renames the helpers, and rewrites Info.plist — and then, with no
 * Developer ID available, skips signing entirely. What ships is therefore the
 * prebuilt Electron binary's own linker signature over a bundle that no longer
 * matches it: `codesign -dvvv` reports `Identifier=Electron` and
 * `Sealed Resources=none`, and there is no Contents/_CodeSignature at all.
 *
 * macOS does not treat that as "unsigned". It treats it as CORRUPT. A user who
 * downloads the dmg gets
 *
 *   "LikeOffice" is damaged and can't be opened. You should move it to the Trash.
 *
 * whose only buttons are Cancel and Move to Trash — there is no override, so
 * the usual right-click > Open advice cannot help them. Ad-hoc signing here
 * replaces that with the ordinary unidentified-developer refusal, which the
 * user can actually get past.
 *
 * This runs in afterPack, which electron-builder invokes BEFORE its own signing
 * step, so a real Developer ID signature (CSC_LINK set) simply replaces this
 * one and nothing is lost. Ad-hoc signing is also a hard requirement on Apple
 * Silicon: arm64 refuses to execute a Mach-O with no valid signature at all.
 */
const { execFileSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const app = readdirSync(context.appOutDir).find((f) => f.endsWith(".app"));
  if (!app) throw new Error(`afterPack: no .app found in ${context.appOutDir}`);
  const appPath = join(context.appOutDir, app);

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  // Fail the build rather than ship a bundle that macOS will call damaged.
  execFileSync("codesign", ["--verify", "--strict", appPath], { stdio: "inherit" });
  console.log(`  • ad-hoc signed  path=${appPath}`);
};
