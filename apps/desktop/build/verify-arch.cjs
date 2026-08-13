"use strict";

/**
 * Refuse to ship a macOS bundle whose native payloads are the wrong CPU.
 *
 * @anthropic-ai/claude-agent-sdk ships its `claude` executable in eight
 * platform-specific optionalDependencies. npm installs only the one matching
 * the BUILD HOST, and electron-builder copies whatever is in node_modules
 * regardless of the --arch it was asked for. Building both macOS arches on one
 * Apple Silicon runner therefore produced an x64 dmg carrying an arm64 binary:
 * the app opened, and every agent feature was dead on an Intel Mac.
 *
 * Building each arch on a runner of that arch makes npm resolve the right
 * package by itself — but "by itself" is the assumption that failed the first
 * time, so the pipeline verifies rather than trusts. A mismatch fails the
 * build instead of producing an installer nobody would test on the arch it is
 * broken on.
 *
 * Called from afterPack (so a mismatch fails the build BEFORE any installer
 * is produced, let alone published) and runnable by hand:
 *
 *   node build/verify-arch.cjs <arm64|x64> [appOutDir]
 */
const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const EXPECTED = { arm64: "arm64", x64: "x86_64" };

/** Every Mach-O architecture in `file`, via lipo. */
function archsOf(file) {
  return execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

/** Throws if any Mach-O in the packed bundle is not `target`. */
function verifyArch(target, outDir) {
  const want = EXPECTED[target];
  if (!want) throw new Error(`verify-arch: expected arm64 or x64, got ${JSON.stringify(target)}`);

  const app = readdirSync(outDir).find((f) => f.endsWith(".app"));
  if (!app) throw new Error(`verify-arch: no .app in ${outDir}`);
  const appPath = join(outDir, app);

  const problems = [];
  const checked = [];

  // 1. The app's own executable — cheap, and catches a wholly mis-targeted build.
  const mainBin = join(appPath, "Contents", "MacOS", app.replace(/\.app$/, ""));
  if (existsSync(mainBin)) {
    const archs = archsOf(mainBin);
    checked.push(`${mainBin} -> ${archs.join(",")}`);
    if (!archs.includes(want)) problems.push(`main executable is ${archs.join(",")}, expected ${want}`);
  }

  // 2. Native payloads unpacked beside the asar. Executables cannot run from
  //    inside an asar, so electron-builder unpacks them here — which is also
  //    where a wrong-arch binary hides.
  const unpacked = join(appPath, "Contents", "Resources", "app.asar.unpacked");
  if (existsSync(unpacked)) {
    for (const file of walk(unpacked)) {
      // Mach-O only: skip the JS, JSON and licence files alongside it.
      if (!(statSync(file).mode & 0o111)) continue;
      let archs;
      try {
        archs = archsOf(file);
      } catch {
        continue; // not a Mach-O
      }
      checked.push(`${file} -> ${archs.join(",")}`);
      if (!archs.includes(want)) problems.push(`${file} is ${archs.join(",")}, expected ${want}`);
    }
  }

  for (const line of checked) console.log(`  checked  ${line}`);

  if (problems.length > 0) {
    throw new Error(
      `verify-arch: ${problems.length} wrong-architecture payload(s) in a ${target} build:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nThis is the #142 failure: npm installs the optional dependency matching the\n" +
        "BUILD HOST, so building this arch on a host of another arch packs the wrong\n" +
        "native binary. Build each arch on a runner of that arch.",
    );
  }
  console.log(`  • verify-arch OK  every native payload is ${want}`);
}

module.exports = { verifyArch };

if (require.main === module) {
  const [target, outDir = "release"] = process.argv.slice(2);
  try {
    verifyArch(target, outDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
