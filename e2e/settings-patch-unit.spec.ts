import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * The settings patch is PARSED, not trusted.
 *
 * `patch: SettingsPatch` is a claim the type system makes about a value that
 * crossed an IPC boundary; it is not a check. The read path already parses
 * settings.json defensively and the write path had the same standing and none
 * of the rigour: the enum fields were validated, the numbers and strings were
 * taken as given.
 *
 * The one with teeth: a non-numeric interval reached `Math.max(5, NaN)` = NaN,
 * and setInterval(NaN) means ZERO delay — the app autosaved roughly 800 times a
 * second, serializing the whole document each time, until it was restarted.
 */
test("a malformed settings patch cannot poison the stored values", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-patch-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    const before = await win.evaluate(() => window.likeoffice.getSettings());

    // Every one of these is a shape the declared type forbids and a renderer
    // could still send.
    const after = await win.evaluate(() =>
      window.likeoffice.setSettings({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        storage: { autosaveSeconds: "not-a-number", autosave: "yes", projectsDir: 42 },
        provider: "not-a-provider",
        spellLanguage: "klingon",
        web: { backend: "google", searxngUrl: null, enabled: "sure" },
        providers: { anthropic: { apiKey: 12345, model: null } },
      } as unknown as SettingsPatch),
    );

    // The interval stays a usable number — never NaN, never below the floor.
    expect(Number.isFinite(after.storage.autosaveSeconds)).toBe(true);
    expect(after.storage.autosaveSeconds).toBeGreaterThanOrEqual(5);
    expect(typeof after.storage.autosave).toBe("boolean");
    expect(typeof after.storage.projectsDir).toBe("string");
    // Unknown enum values fall back rather than being stored.
    expect(after.provider).toBe(before.provider);
    expect(after.spellLanguage).toBe(before.spellLanguage);
    expect(after.web.backend).toBe(before.web.backend);
    expect(typeof after.web.searxngUrl).toBe("string");
    expect(typeof after.web.enabled).toBe("boolean");
    // A non-string key is ignored rather than crashing the seal on write.
    expect(after.providers.find((p) => p.id === "anthropic")?.hasKey).toBe(before.hasKey);

    // And it survives the round trip to disk and back.
    const reread = await win.evaluate(() => window.likeoffice.getSettings());
    expect(Number.isFinite(reread.storage.autosaveSeconds)).toBe(true);
  } finally {
    await app.close();
  }
});

test("an unknown provider id to models:list falls back instead of throwing", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-models-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    // Used to index the provider map with the bogus id and TypeError.
    const catalogue = await win.evaluate(() =>
      window.likeoffice.listModels("nope" as unknown as Provider),
    );
    expect(Array.isArray(catalogue.models)).toBe(true);
  } finally {
    await app.close();
  }
});
