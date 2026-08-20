import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");
/**
 * Fixtures built by scripts/make-latency-fixtures.mjs. Point at them with
 * LIKEOFFICE_LATENCY_FIXTURES; both are ~794,000 characters, the size of the
 * document this was reported on.
 */
const FIXTURES = process.env.LIKEOFFICE_LATENCY_FIXTURES ?? "";
const KEYS = Number(process.env.LIKEOFFICE_LATENCY_KEYS ?? 40);

/**
 * TYPING LATENCY IN THE APP, not in a headless approximation.
 *
 * Every number here is measured in the shipped Electron renderer, driving real
 * keyboard input through CDP. Two clocks, because they answer different
 * questions:
 *
 *  - `blocked` is the main thread held busy by one keystroke: the engine's own
 *    per-commit samples (refresh + layout + render). This is the number an
 *    optimisation moves.
 *  - `toPaint` is keydown until the frame that shows the character — what the
 *    typist actually feels. It includes the browser's own style, layout and
 *    paint on top of the engine's work, so it is always the larger number.
 */
async function measure(fixture: string): Promise<{
  label: string;
  toPaint: number[];
  blocked: number[];
  phases: Record<string, number>;
  scan: Record<string, number>;
  pages: number;
}> {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-latency-"));
  const app = await electron.launch({
    args: [APP_DIR, fixture],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 120000 });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1600, 1000);
    });

    // Arm the engine's per-commit instrument and the keydown→paint clock. The
    // keydown listener runs in the CAPTURE phase so t0 is taken before the
    // editor sees the key; the rAF it schedules fires just before the frame
    // that includes the resulting paint.
    await win.evaluate(() => {
      const w = window as unknown as {
        __dxwPerf: { samples: Record<string, number>[] };
        __toPaint: number[];
      };
      w.__dxwPerf = { samples: [] };
      w.__toPaint = [];
      document.addEventListener(
        "keydown",
        () => {
          const t0 = performance.now();
          requestAnimationFrame(() => w.__toPaint.push(performance.now() - t0));
        },
        true,
      );
    });

    // Type into the MIDDLE of the document: the first paragraph is the cheapest
    // possible case on a paged layout, and nobody writes only at the top.
    const pages = await win.locator(".dxw-page").count();
    const middle = win.locator(".dxw-page").nth(Math.floor(pages / 2));
    await middle.scrollIntoViewIfNeeded();
    await middle.click();
    await win.waitForTimeout(500);
    // Discard the click's own commit; only steady-state typing is measured.
    await win.evaluate(() => {
      const w = window as unknown as {
        __dxwPerf: { samples: unknown[] };
        __toPaint: number[];
      };
      w.__dxwPerf.samples.length = 0;
      w.__toPaint.length = 0;
      (window as unknown as { __dxwPerf: { width?: unknown } }).__dxwPerf.width = { hit: 0, miss: 0, chars: 0 };
    });

    for (let i = 0; i < KEYS; i++) {
      await win.keyboard.type("a", { delay: 0 });
      // One frame between keystrokes, so each sample is one keystroke's work
      // rather than a coalesced burst.
      await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
    await win.waitForTimeout(300);

    const result = await win.evaluate(() => {
      const w = window as unknown as {
        __dxwPerf: { samples: Record<string, number>[] };
        __toPaint: number[];
      };
      const s = w.__dxwPerf.samples;
      // Mean per keystroke for every phase the engine records, so the cost has
      // somewhere to be rather than just a total.
      const phases: Record<string, number> = {};
      for (const key of Object.keys(s[0] ?? {})) {
        phases[key] = s.reduce((a, x) => a + (x[key] ?? 0), 0) / Math.max(1, s.length);
      }
      const perf = (window as unknown as {
        __dxwPerf: {
          scan?: Record<string, number>;
          incr?: Record<string, number>;
          width?: { hit: number; miss: number; chars: number };
        };
      }).__dxwPerf;
      const n = Math.max(1, s.length);
      const scan = {
        ...(perf.scan ?? {}),
        ...(perf.incr ?? {}),
        widthHitPerKey: (perf.width?.hit ?? 0) / n,
        widthMissPerKey: (perf.width?.miss ?? 0) / n,
        // Characters of text measurement per keystroke. This is the number
        // that separates the two document shapes; see Measurer.width.
        measuredCharsPerKey: (perf.width?.chars ?? 0) / n,
      };
      return {
        toPaint: w.__toPaint,
        blocked: s.map((x) => x.total ?? 0),
        phases,
        scan: scan ?? {},
      };
    });
    return { label: path.basename(fixture), pages, ...result };
  } finally {
    // See watermark.spec.ts: a graceful close hangs in this harness.
    app.process().kill("SIGKILL");
  }
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "n/a");

test("typing latency on a 794k-character document", async () => {
  test.setTimeout(600000);
  test.skip(!FIXTURES, "set LIKEOFFICE_LATENCY_FIXTURES to the fixture directory");

  for (const name of ["bigparas", "novel"]) {
    const r = await measure(path.join(FIXTURES, `${name}.docx`));
    console.log(
      `LATENCY ${r.label} pages=${r.pages} keys=${r.blocked.length} ` +
        `blockedP50=${fmt(pct(r.blocked, 50))} blockedP90=${fmt(pct(r.blocked, 90))} ` +
        `paintP50=${fmt(pct(r.toPaint, 50))} paintP90=${fmt(pct(r.toPaint, 90))}`,
    );
    console.log(
      `LATENCY-PHASES ${r.label} ` +
        Object.entries(r.phases)
          .filter(([k]) => k !== "total")
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(" "),
    );
    console.log(
      `LATENCY-SCAN ${r.label} ` +
        Object.entries(r.scan).map(([k, v]) => `${k}=${fmt(v)}`).join(" "),
    );
    expect(r.blocked.length).toBeGreaterThan(0);
  }
});
