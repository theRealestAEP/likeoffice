import { useEffect, useState } from "react";

const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];

export function SettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (settings: SettingsView) => void;
}) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [key, setKey] = useState("");

  useEffect(() => {
    void window.likeoffice.getSettings().then(setSettings);
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
    );
    onSaved(saved);
    onClose();
  };

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

        <label className="field-label">Anthropic API key</label>
        <input
          className="field-input"
          type="password"
          value={key}
          autoFocus
          placeholder={settings.hasKey ? "A key is saved — type to replace it" : "sk-ant-…"}
          onChange={(e) => setKey(e.target.value)}
        />

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
