import { useEffect, useState } from "react";

const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "anthropic-api", label: "Anthropic API key" },
  { id: "claude-subscription", label: "Claude subscription (Claude Code)" },
  { id: "codex-subscription", label: "ChatGPT subscription (Codex)" },
];

function cliStatusText(
  status: CliStatus | undefined,
  cli: { name: string; install: string; login: string },
): string {
  if (!status) return "Checking…";
  if (!status.installed) {
    return `${cli.name} is not installed. Install it with: ${cli.install}`;
  }
  if (!status.loggedIn) {
    return `${cli.name} ${status.version ?? ""} is installed but not signed in. Run: ${cli.login}`;
  }
  return `${cli.name} ${status.version ?? ""} — signed in.`;
}

export function SettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (settings: SettingsView) => void;
}) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [key, setKey] = useState("");

  useEffect(() => {
    void window.likeoffice.getSettings().then(setSettings);
    void window.likeoffice.getProviderStatus().then(setStatus);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!settings) return null;

  const save = async () => {
    const saved = await window.likeoffice.setSettings(
      key.trim() === "" ? null : key.trim(),
      settings.model,
      settings.provider,
      settings.spellLanguage,
    );
    onSaved(saved);
    onClose();
  };

  const statusText =
    settings.provider === "anthropic-api"
      ? settings.hasKey || key.trim() !== ""
        ? "An API key is saved."
        : "No API key is set."
      : settings.provider === "claude-subscription"
        ? cliStatusText(status?.claude, {
            name: "Claude Code",
            install: "npm install -g @anthropic-ai/claude-code",
            login: "claude auth login",
          })
        : cliStatusText(status?.codex, {
            name: "Codex",
            install: "npm install -g @openai/codex",
            login: "codex login",
          });

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">Settings</h2>

        <label className="field-label">AI provider</label>
        <select
          className="field-input"
          value={settings.provider}
          onChange={(e) => setSettings({ ...settings, provider: e.target.value as Provider })}
          data-testid="settings-provider"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="field-hint" data-testid="provider-status">
          {statusText}
        </div>

        {settings.provider === "anthropic-api" && (
          <>
            <label className="field-label">Anthropic API key</label>
            <input
              className="field-input"
              type="password"
              value={key}
              autoFocus
              placeholder={settings.hasKey ? "A key is saved — type to replace it" : "sk-ant-…"}
              onChange={(e) => setKey(e.target.value)}
            />
          </>
        )}

        {settings.provider !== "codex-subscription" && (
          <>
            <label className="field-label">Model</label>
            <select
              className="field-input"
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </>
        )}
        {settings.provider === "codex-subscription" && (
          <div className="field-hint">Codex uses the model configured in the Codex CLI.</div>
        )}

        <label className="field-label">Spellcheck language</label>
        <select
          className="field-input"
          value={settings.spellLanguage}
          onChange={(e) => setSettings({ ...settings, spellLanguage: e.target.value })}
          data-testid="settings-spell-language"
        >
          <option value="system">System language</option>
          <option value="en-US">English (United States)</option>
          <option value="off">Off</option>
        </select>
        <div className="field-hint">
          English (US) is the bundled dictionary; other system languages turn spellcheck off.
        </div>

        <div className="dialog-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
