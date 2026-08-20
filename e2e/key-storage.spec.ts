import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");
const SECRET = "sk-ant-do-not-store-me-in-the-clear";

/**
 * API keys must not sit in settings.json as plain text.
 *
 * The file is readable by anything running as the user, and it follows the user
 * into backups and synced folders. These assertions are about the BYTES ON
 * DISK, because that is the thing that leaks — an in-memory check would pass
 * either way.
 */
test("a saved key is not readable in settings.json, and still works", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-keys-"));
  const settingsFile = path.join(userData, "settings.json");
  const launch = () =>
    electron.launch({
      args: [APP_DIR],
      env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
    });

  let app = await launch();
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await win.evaluate(
      (secret) => window.likeoffice.setSettings({ providers: { anthropic: { apiKey: secret } } }),
      SECRET,
    );

    const onDisk = await readFile(settingsFile, "utf8");
    // Only meaningful where the platform actually has a keyring; a CI box
    // without one keeps the old behaviour on purpose (see sealSecret).
    const encryptionAvailable = await app.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable(),
    );
    if (encryptionAvailable) {
      expect(onDisk).not.toContain(SECRET);
      expect(onDisk).toContain("enc:v1:");
    }
    // Either way the app must still report a key as present.
    const view = await win.evaluate(() => window.likeoffice.getSettings());
    expect(view.providers.find((p) => p.id === "anthropic")?.hasKey).toBe(true);
  } finally {
    await app.close();
  }

  // …and it survives a restart, which is what "still works" means.
  app = await launch();
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    const view = await win.evaluate(() => window.likeoffice.getSettings());
    expect(view.providers.find((p) => p.id === "anthropic")?.hasKey).toBe(true);
  } finally {
    await app.close();
  }
});

test("a key written by an older build is read, then sealed on the next save", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-keys-legacy-"));
  const settingsFile = path.join(userData, "settings.json");
  // Exactly what a pre-safeStorage build left behind: a bare string.
  await writeFile(
    settingsFile,
    JSON.stringify({ provider: "anthropic", providers: { anthropic: { apiKey: SECRET, baseUrl: "", model: "claude-opus-5" } } }),
  );

  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    // Read without re-entry: nobody should have to paste their key again.
    const before = await win.evaluate(() => window.likeoffice.getSettings());
    expect(before.providers.find((p) => p.id === "anthropic")?.hasKey).toBe(true);

    // Any save seals it.
    await win.evaluate(() => window.likeoffice.setSettings({ spellLanguage: "off" }));
    const encryptionAvailable = await app.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable(),
    );
    if (encryptionAvailable) {
      expect(await readFile(settingsFile, "utf8")).not.toContain(SECRET);
    }
  } finally {
    await app.close();
  }
});
