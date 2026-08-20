import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * The AI panel's model picker must not move the panel.
 *
 * `.ai-panel` is `overflow: hidden`, which does NOT make it unscrollable — it
 * only hides the scrollbar. The menu was wider than its narrow trigger, so
 * focusing the filter input asked the browser to scroll the panel until the
 * input was visible, and every other thing in the panel slid left behind a
 * clipped edge with no scrollbar to bring it back.
 */
test("opening the model dropdown leaves the AI panel where it was", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, ANTHROPIC: "" },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.getByTestId("ai-toggle").click();
  const panel = win.locator(".ai-panel");
  await expect(panel).toBeVisible();

  await win.getByTestId("ai-model").click();
  await expect(win.getByTestId("ai-model-filter")).toBeVisible();

  // Nothing scrolled: the panel's content is still at its left edge.
  expect(await panel.evaluate((el) => el.scrollLeft)).toBe(0);

  // And nothing could have: the open menu fits inside the panel.
  const fits = await panel.evaluate((el) => {
    const menu = el.querySelector(".dd-menu");
    if (!menu) return "no menu";
    const m = menu.getBoundingClientRect();
    const p = el.getBoundingClientRect();
    return m.left >= p.left - 0.5 && m.right <= p.right + 0.5
      ? "fits"
      : `menu ${m.left}..${m.right} outside panel ${p.left}..${p.right}`;
  });
  expect(fits).toBe("fits");

  await app.close();
});
