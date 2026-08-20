import { useCallback, useEffect, useState } from "react";
import { Dropdown } from "./Dropdown";

/**
 * The settings surface.
 *
 * Sectioned rather than one column of fields: the old dialog held four
 * controls, and this holds provider credentials, endpoints, model catalogues
 * and editor preferences. A left rail keeps each concern findable instead of
 * making the user scroll a growing list to reach spellcheck.
 */

type Section = "models" | "web" | "storage" | "editor";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "web", label: "Web" },
  { id: "storage", label: "Storage" },
  { id: "editor", label: "Editor" },
];

/** Where web_search sends queries. SearXNG is first and default because it is
 * the only one that needs no account: the user runs the instance. */
const SEARCH_BACKENDS: { id: WebSearchBackend; label: string; note: string }[] = [
  {
    id: "direct",
    label: "DuckDuckGo (nothing to set up)",
    note: "Asks DuckDuckGo directly. Works out of the box; heavy use can be rate-limited, and result markup changes from time to time.",
  },
  {
    id: "searxng",
    label: "SearXNG (self-hosted, no key)",
    note: "Run one with: docker run -d -p 8080:8080 searxng/searxng — then enable JSON output by adding \"json\" to the formats list under search: in its settings.yml.",
  },
  { id: "brave", label: "Brave Search API", note: "Hosted. Needs a key from api-dashboard.search.brave.com." },
  { id: "tavily", label: "Tavily", note: "Hosted, built for agents. Needs a key from tavily.com." },
  { id: "exa", label: "Exa", note: "Hosted neural search — the backend Cursor uses. Needs a key from exa.ai." },
];

/** How to reach each provider, and what to say when it is not set up. The CLI
 * pair carry install/sign-in instructions instead of a key field. */
/** ANNOTATED, not `satisfies`. The entries deliberately have different shapes —
 * only some carry a key placeholder or an editable base URL — and the annotation
 * is what gives every one of them the same optional-property type to read. With
 * `satisfies` the literal types survive and each entry loses the keys it does
 * not declare, which is a narrowing this code does not want. */
const PROVIDER_HELP: Record<
  Provider,
  { blurb: string; keyPlaceholder?: string; keyUrl?: string; editableBaseUrl?: boolean }
> = {
  anthropic: {
    blurb: "Claude models, billed to an Anthropic API key.",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    blurb: "GPT models, billed to an OpenAI API key.",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    blurb: "One key, most models — Anthropic, OpenAI, Google, Meta and others through a single endpoint.",
    keyPlaceholder: "sk-or-…",
    keyUrl: "https://openrouter.ai/keys",
  },
  ollama: {
    blurb: "Models running on this machine. Nothing leaves it, and no key is needed — just Ollama running.",
    editableBaseUrl: true,
  },
  custom: {
    blurb: "Any OpenAI-compatible endpoint: LM Studio, vLLM, llama.cpp, a company gateway.",
    keyPlaceholder: "Optional",
    editableBaseUrl: true,
  },
  "claude-subscription": {
    blurb: "Runs through the Claude Code CLI and your Claude subscription, so there is no API bill.",
  },
  "codex-subscription": {
    blurb: "Runs through the Codex CLI and your ChatGPT subscription. Codex chooses its own model.",
  },
};

function cliStatusText(
  status: CliStatus | undefined,
  cli: { name: string; install: string; login: string },
): string {
  if (!status) return "Checking…";
  if (!status.installed) return `${cli.name} is not installed. Install it with: ${cli.install}`;
  if (!status.loggedIn) {
    return `${cli.name} ${status.version ?? ""} is installed but not signed in. Run: ${cli.login}`;
  }
  return `${cli.name} ${status.version ?? ""} — signed in.`;
}

function ProviderCard({
  provider,
  active,
  status,
  draftKey,
  onDraftKey,
  onUse,
  onPatch,
}: {
  provider: ProviderView;
  active: boolean;
  status: ProviderStatus | null;
  draftKey: string;
  onDraftKey: (value: string) => void;
  onUse: () => void;
  onPatch: (patch: { baseUrl?: string; model?: string }) => void;
}) {
  const help = PROVIDER_HELP[provider.id];
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCatalogue(await window.likeoffice.listModels(provider.id));
    } finally {
      setLoading(false);
    }
  }, [provider.id]);

  // Only the open provider's catalogue is fetched, and only once it matters:
  // listing every provider on mount would hit four networks to draw a page.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const cliText =
    provider.id === "claude-subscription"
      ? cliStatusText(status?.claude, {
          name: "Claude Code",
          install: "npm install -g @anthropic-ai/claude-code",
          login: "claude auth login",
        })
      : provider.id === "codex-subscription"
        ? cliStatusText(status?.codex, {
            name: "Codex",
            install: "npm install -g @openai/codex",
            login: "codex login",
          })
        : "";

  const ready = provider.keyed
    ? provider.id === "ollama" || provider.hasKey || draftKey.trim() !== ""
    : undefined;

  return (
    <div className={`provider-card${active ? " provider-card-active" : ""}`} data-provider={provider.id}>
      <div className="provider-head">
        <div>
          <div className="provider-name">
            {provider.label}
            {active && <span className="provider-badge">In use</span>}
          </div>
          <div className="provider-blurb">{help.blurb}</div>
        </div>
        {!active && (
          <button className="btn btn-ghost" onClick={onUse} data-testid={`use-${provider.id}`}>
            Use
          </button>
        )}
      </div>

      {provider.keyed && provider.id !== "ollama" && (
        <>
          <label className="field-label">API key</label>
          <input
            className="field-input"
            type="password"
            value={draftKey}
            placeholder={provider.hasKey ? "A key is saved — type to replace it" : help.keyPlaceholder}
            onChange={(e) => onDraftKey(e.target.value)}
            data-testid={`key-${provider.id}`}
          />
          {help.keyUrl && (
            <div className="field-hint">
              Get one at <span className="provider-url">{help.keyUrl}</span>
            </div>
          )}
        </>
      )}

      {help.editableBaseUrl && (
        <>
          <label className="field-label">Base URL</label>
          <input
            className="field-input"
            value={provider.baseUrl}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => onPatch({ baseUrl: e.target.value })}
            data-testid={`base-${provider.id}`}
          />
        </>
      )}

      {cliText && <div className="field-hint" data-testid="provider-status">{cliText}</div>}

      {provider.id !== "codex-subscription" && (
        <>
          <label className="field-label">Model</label>
          <div className="provider-model-row">
            <Dropdown
              ariaLabel={`${provider.label} model`}
              testId={`model-${provider.id}`}
              value={provider.model}
              placeholder="Choose or type a model id"
              freeText
              searchable
              options={(catalogue?.models ?? []).map((m) => ({
                value: m.id,
                label: m.id,
                hint: m.label !== m.id ? m.label : undefined,
              }))}
              onChange={(next) => onPatch({ model: next })}
            />
            <button className="btn btn-ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? "…" : "Refresh"}
            </button>
          </div>
          {/* A typed id is always allowed: a provider can offer a model its
              own list endpoint has not caught up with, and refusing it would
              make the app the reason a working model cannot be used. */}
          {catalogue?.error && <div className="field-hint">{catalogue.error}</div>}
          {catalogue && !catalogue.error && (
            <div className="field-hint">
              {catalogue.models.length} model{catalogue.models.length === 1 ? "" : "s"}
              {catalogue.live ? " from this provider" : " (built-in list)"} — any id can be typed.
            </div>
          )}
        </>
      )}

      {ready === false && <div className="field-hint provider-warn">Add a key before using this provider.</div>}
    </div>
  );
}

export function SettingsPage({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (settings: SettingsView) => void;
}) {
  const [section, setSection] = useState<Section>("models");
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  /** Typed keys, held per provider until Save. They are write-only: the page
   * is never given the stored key, so an untouched field sends null. */
  const [keys, setKeys] = useState<Record<string, string>>({});
  /** The web search key, held the same write-only way as the provider keys. */
  const [webKey, setWebKey] = useState("");

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

  const patchProvider = (id: Provider, patch: { baseUrl?: string; model?: string }) => {
    setSettings({
      ...settings,
      providers: settings.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };

  const save = async () => {
    const providers: SettingsPatch["providers"] = {};
    for (const p of settings.providers) {
      const typed = keys[p.id];
      providers[p.id] = {
        apiKey: typed === undefined || typed.trim() === "" ? null : typed.trim(),
        baseUrl: p.baseUrl,
        model: p.model,
      };
    }
    const saved = await window.likeoffice.setSettings({
      provider: settings.provider,
      spellLanguage: settings.spellLanguage,
      providers,
      storage: settings.storage,
      web: {
        backend: settings.web.backend,
        searxngUrl: settings.web.searxngUrl,
        apiKey: webKey.trim() === "" ? null : webKey.trim(),
        enabled: settings.web.enabled,
      },
    });
    onSaved(saved);
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog dialog-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item${section === s.id ? " settings-nav-item-active" : ""}`}
                aria-current={section === s.id}
                onClick={() => setSection(s.id)}
                data-testid={`settings-section-${s.id}`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {section === "models" && (
              <>
                <h2 className="dialog-title">Models</h2>
                <p className="dialog-lede">
                  The provider marked <em>In use</em> answers the AI panel. Keys are stored on this machine and
                  never leave the app's main process.
                </p>
                {/* The plain select stays, and keeps its testid: it is the
                    accessible way to change provider, and the e2e drives it. */}
                <label className="field-label">Active provider</label>
                <select
                  className="field-input"
                  value={settings.provider}
                  onChange={(e) => setSettings({ ...settings, provider: e.target.value as Provider })}
                  data-testid="settings-provider"
                >
                  {settings.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>

                {settings.providers.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    active={p.id === settings.provider}
                    status={status}
                    draftKey={keys[p.id] ?? ""}
                    onDraftKey={(value) => setKeys({ ...keys, [p.id]: value })}
                    onUse={() => setSettings({ ...settings, provider: p.id })}
                    onPatch={(patch) => patchProvider(p.id, patch)}
                  />
                ))}
              </>
            )}

            {section === "web" && (
              <>
                <h2 className="dialog-title">Web</h2>
                <p className="dialog-lede">
                  Gives the assistant two tools: search the web, and read a page. Reading a page needs
                  nothing configured — it happens inside LikeOffice. Searching needs somewhere to send the
                  query.
                </p>

                <label className="field-label">
                  <input
                    type="checkbox"
                    checked={settings.web.enabled}
                    onChange={(e) =>
                      setSettings({ ...settings, web: { ...settings.web, enabled: e.target.checked } })
                    }
                    data-testid="web-enabled"
                  />{" "}
                  Let the assistant search and read the web
                </label>

                <label className="field-label">Search through</label>
                <select
                  className="field-input"
                  value={settings.web.backend}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      web: { ...settings.web, backend: e.target.value as WebSearchBackend },
                    })
                  }
                  data-testid="web-backend"
                >
                  {SEARCH_BACKENDS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <div className="field-hint">
                  {SEARCH_BACKENDS.find((b) => b.id === settings.web.backend)?.note}
                </div>

                {settings.web.backend === "direct" ? null : settings.web.backend === "searxng" ? (
                  <>
                    <label className="field-label">SearXNG address</label>
                    <input
                      className="field-input"
                      value={settings.web.searxngUrl}
                      placeholder="http://localhost:8080"
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          web: { ...settings.web, searxngUrl: e.target.value },
                        })
                      }
                      data-testid="web-searxng-url"
                    />
                  </>
                ) : (
                  <>
                    <label className="field-label">API key</label>
                    <input
                      className="field-input"
                      type="password"
                      value={webKey}
                      placeholder={settings.web.hasKey ? "A key is saved — type to replace it" : "Paste the key"}
                      onChange={(e) => setWebKey(e.target.value)}
                      data-testid="web-key"
                    />
                  </>
                )}

              </>
            )}

            {section === "storage" && (
              <>
                <h2 className="dialog-title">Storage</h2>
                <p className="dialog-lede">
                  A recovery copy is always kept, autosave or not — turning autosave off means "do not
                  touch my file", not "lose my work".
                </p>

                <label className="field-label">
                  <input
                    type="checkbox"
                    checked={settings.storage.autosave}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        storage: { ...settings.storage, autosave: e.target.checked },
                      })
                    }
                    data-testid="autosave-enabled"
                  />{" "}
                  Save the document's own file automatically
                </label>
                <div className="field-hint">
                  A document that has never been saved has no file to write, so it keeps the recovery copy
                  until you save it once.
                </div>

                <label className="field-label">Save every</label>
                <select
                  className="field-input"
                  value={String(settings.storage.autosaveSeconds)}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      storage: { ...settings.storage, autosaveSeconds: Number(e.target.value) },
                    })
                  }
                  data-testid="autosave-seconds"
                >
                  <option value="10">10 seconds</option>
                  <option value="30">30 seconds</option>
                  <option value="60">1 minute</option>
                  <option value="300">5 minutes</option>
                </select>

                <label className="field-label">Projects folder</label>
                <div className="provider-model-row">
                  <input
                    className="field-input"
                    value={settings.storage.projectsDir}
                    placeholder="Ask me each time"
                    readOnly
                    data-testid="projects-dir"
                  />
                  <button
                    className="btn btn-ghost"
                    onClick={async () => {
                      const dir = await window.likeoffice.chooseProjectsDir();
                      if (dir) {
                        setSettings({ ...settings, storage: { ...settings.storage, projectsDir: dir } });
                      }
                    }}
                  >
                    Choose…
                  </button>
                </div>
                <div className="field-hint">
                  Where Save opens for a new document. Leave it empty to be asked each time.
                </div>
              </>
            )}

            {section === "editor" && (
              <>
                <h2 className="dialog-title">Editor</h2>
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
              </>
            )}
          </div>
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
