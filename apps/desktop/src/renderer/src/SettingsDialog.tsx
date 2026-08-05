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
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: 20,
          width: 420,
          font: "13px system-ui, sans-serif",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 16px", fontSize: 16 }}>Settings</h2>

        <label style={{ display: "block", marginBottom: 4 }}>Anthropic API key</label>
        <input
          type="password"
          value={key}
          autoFocus
          placeholder={settings.hasKey ? "A key is saved — type to replace it" : "sk-ant-…"}
          onChange={(e) => setKey(e.target.value)}
          style={{ width: "100%", padding: 6, marginBottom: 16, boxSizing: "border-box" }}
        />

        <label style={{ display: "block", marginBottom: 4 }}>Model</label>
        <select
          value={settings.model}
          onChange={(e) => setSettings({ ...settings, model: e.target.value })}
          style={{ width: "100%", padding: 6, marginBottom: 20, boxSizing: "border-box" }}
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
