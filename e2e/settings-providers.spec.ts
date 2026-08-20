import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/** Every provider the settings page offers, in the order it lists them. */
const PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "ollama",
  "custom",
  "claude-subscription",
  "codex-subscription",
];

// Under LIKEOFFICE_FAKE_MODEL the main process reports both CLIs as not
// installed, so the not-installed hints render deterministically on any
// machine.
test("the settings page offers every provider and degrades gracefully", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "settings");
    });

    const provider = win.getByTestId("settings-provider");
    await expect(provider).toBeVisible();
    await expect(provider.locator("option")).toHaveCount(PROVIDERS.length);

    // A keyed provider with no key says so, and says it about ITSELF rather
    // than about Anthropic — the bug that made the old copy wrong the moment
    // anyone picked a different provider.
    await expect(win.locator('[data-provider="anthropic"]')).toContainText("Add a key before using this provider");

    // Each keyed provider carries its own key field and its own model, so one
    // provider's configuration can never be read as another's.
    for (const id of ["openai", "openrouter", "custom"]) {
      await expect(win.getByTestId(`key-${id}`)).toBeAttached();
    }
    // Ollama needs no key, and takes a base URL instead.
    await expect(win.getByTestId("key-ollama")).toHaveCount(0);
    await expect(win.getByTestId("base-ollama")).toBeAttached();

    await provider.selectOption("claude-subscription");
    await expect(win.getByTestId("provider-status").first()).toContainText("Claude Code is not installed");

    await provider.selectOption("codex-subscription");
    await expect(win.getByTestId("provider-status").last()).toContainText("Codex is not installed");

    // The provider choice persists through save. Saving is asynchronous and the
    // page closes only once the write resolves, so re-opening before that
    // lands leaves the pending close to shut the page the assertion needs.
    await win.getByRole("button", { name: "Save" }).click();
    await expect(provider).toBeHidden();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "settings");
    });
    await expect(win.getByTestId("settings-provider")).toHaveValue("codex-subscription");
  } finally {
    await app.close();
  }
});

test("a per-provider model survives switching providers and a restart", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const launch = () =>
    electron.launch({
      args: [APP_DIR],
      env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
    });

  let app = await launch();
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "settings");
    });

    // Two providers, two different models. The point of storing a model PER
    // provider is that choosing one never silently repoints the other.
    // The model control is the app's own dropdown, not a text input: open it,
    // type an id the list does not carry, and Enter takes the typed value —
    // the free-form path that lets a brand-new model be used on day one.
    const setModel = async (provider: string, id: string) => {
      await win.getByTestId(`model-${provider}`).click();
      await win.getByTestId(`model-${provider}-filter`).fill(id);
      await win.getByTestId(`model-${provider}-filter`).press("Enter");
      await expect(win.getByTestId(`model-${provider}`)).toContainText(id);
    };
    await setModel("openrouter", "meta-llama/llama-3.1-70b-instruct");
    await setModel("openai", "gpt-5-mini");
    await win.getByTestId("settings-provider").selectOption("openrouter");
    await win.getByRole("button", { name: "Save" }).click();
    await expect(win.getByTestId("settings-provider")).toBeHidden();
  } finally {
    await app.close();
  }

  app = await launch();
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "settings");
    });
    await expect(win.getByTestId("settings-provider")).toHaveValue("openrouter");
    await expect(win.getByTestId("model-openrouter")).toContainText("meta-llama/llama-3.1-70b-instruct");
    await expect(win.getByTestId("model-openai")).toContainText("gpt-5-mini");
  } finally {
    await app.close();
  }
});
