import { useCallback, useEffect, useRef, useState } from "react";

/** Mirrors MAX_INSTRUCTIONS in main/profiles.ts, which truncates past it. */
const MAX_INSTRUCTIONS = 4000;

const EMPTY: ProfilesState = { profiles: [], activeId: "" };

/** Fold the active profile into the panel's system prompt. The base contract
 * comes first and is never edited: the profile is appended as its own
 * delimited section that speaks only to the content the model writes. */
export function composeSystemPrompt(base: string, profile: Profile | null): string {
  const instructions = profile?.instructions.trim() ?? "";
  if (!profile || instructions === "") return base;
  return `${base}\n\nThe user has selected the "${profile.name}" profile. Apply its guidance to the CONTENT you write, without changing how you use the tools:\n${instructions}`;
}

export interface ProfilesHandle {
  state: ProfilesState;
  active: Profile | null;
  setState: (state: ProfilesState) => void;
}

/** The profile list and the one globally active profile, kept in step with
 * the main process — including changes another window made. */
export function useProfiles(): ProfilesHandle {
  const [state, setState] = useState<ProfilesState>(EMPTY);
  useEffect(() => {
    const load = () => void window.likeoffice.getProfiles().then(setState);
    load();
    return window.likeoffice.onProfilesChanged(load);
  }, []);
  return {
    state,
    active: state.profiles.find((p) => p.id === state.activeId) ?? null,
    setState,
  };
}

/** Emoji widths vary and not every profile has one, so the icon gets a fixed
 * slot and every name in the menu starts on the same edge. */
function ProfileLabel({ profile }: { profile: Profile | null }) {
  return (
    <span className="ai-profile-name">
      <span className="ai-profile-emoji" aria-hidden="true">
        {profile?.emoji}
      </span>
      {profile ? profile.name : "No profile"}
    </span>
  );
}

/** The AI panel's header strip: which profile is steering this conversation,
 * with a menu to switch or to open the management dialog. */
export function AiProfileHeader({ profiles }: { profiles: ProfilesHandle }) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = async (id: string) => {
    setOpen(false);
    profiles.setState(await window.likeoffice.setActiveProfile(id));
  };

  return (
    <div className="ai-header" ref={rootRef}>
      <span className="ai-header-label">Profile</span>
      <button
        className="ai-profile-button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={profiles.active?.instructions ?? "The assistant's default voice."}
        data-testid="ai-profile-button"
      >
        <ProfileLabel profile={profiles.active} />
        <svg viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 1.5 5 5 9 1.5" />
        </svg>
      </button>

      {open && (
        <div className="ai-profile-menu" role="menu" data-testid="ai-profile-menu">
          <ProfileMenuItem
            active={profiles.state.activeId === ""}
            profile={null}
            hint="The assistant's default voice."
            onClick={() => void choose("")}
          />
          {profiles.state.profiles.map((p) => (
            <ProfileMenuItem
              key={p.id}
              active={p.id === profiles.state.activeId}
              profile={p}
              hint={p.instructions}
              onClick={() => void choose(p.id)}
            />
          ))}
          <div className="ai-profile-menu-rule" />
          <button
            className="ai-profile-item ai-profile-manage"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setManaging(true);
            }}
            data-testid="ai-profile-manage"
          >
            Manage profiles…
          </button>
        </div>
      )}

      {managing && (
        <ProfilesDialog profiles={profiles} onClose={() => setManaging(false)} />
      )}
    </div>
  );
}

function ProfileMenuItem({
  active,
  profile,
  hint,
  onClick,
}: {
  active: boolean;
  profile: Profile | null;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`ai-profile-item${active ? " active" : ""}`}
      role="menuitemradio"
      aria-checked={active}
      title={hint}
      onClick={onClick}
    >
      <span className="ai-profile-check" aria-hidden="true">
        {active ? "✓" : ""}
      </span>
      <ProfileLabel profile={profile} />
    </button>
  );
}

interface Draft {
  id: string;
  name: string;
  emoji: string;
  instructions: string;
}

function draftOf(profile: Profile): Draft {
  return {
    id: profile.id,
    name: profile.name,
    emoji: profile.emoji,
    instructions: profile.instructions,
  };
}

/** List on the left, editor on the right. Every action writes straight
 * through to the store, and the draft in the editor commits when the user
 * moves to another profile or closes the dialog. */
function ProfilesDialog({
  profiles,
  onClose,
}: {
  profiles: ProfilesHandle;
  onClose: () => void;
}) {
  const list = profiles.state.profiles;
  const [selectedId, setSelectedId] = useState(
    profiles.state.activeId || (list[0]?.id ?? ""),
  );
  const selected = list.find((p) => p.id === selectedId) ?? null;
  const [draft, setDraft] = useState<Draft | null>(selected ? draftOf(selected) : null);

  // The draft follows the selection, and picks up profiles created or
  // duplicated by the buttons below (which select what they create).
  // updatedAt, not the profile object, keeps this from firing every render.
  useEffect(() => {
    setDraft(selected ? draftOf(selected) : null);
  }, [selectedId, selected?.updatedAt]);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const listRef = useRef(list);
  listRef.current = list;

  const setProfilesState = profiles.setState;

  /** Write the draft back if the user changed anything. */
  const flush = useCallback(async (): Promise<void> => {
    const d = draftRef.current;
    const stored = listRef.current.find((p) => p.id === d?.id);
    if (!d || !stored || stored.builtIn) return;
    if (
      d.name === stored.name &&
      d.emoji === stored.emoji &&
      d.instructions === stored.instructions
    ) {
      return;
    }
    setProfilesState(await window.likeoffice.updateProfile(d.id, d.name, d.emoji, d.instructions));
  }, [setProfilesState]);

  const close = useCallback(async () => {
    await flush();
    onClose();
  }, [flush, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const select = async (id: string) => {
    await flush();
    setSelectedId(id);
  };

  /** Commit the draft, run a store action, then follow the profile it left
   * active — create and duplicate both select what they made. */
  const act = async (action: () => Promise<ProfilesState>, follow: boolean) => {
    await flush();
    const next = await action();
    setProfilesState(next);
    if (follow) setSelectedId(next.activeId);
  };

  const remove = async () => {
    if (!selected) return;
    const next = await window.likeoffice.deleteProfile(selected.id);
    setProfilesState(next);
    setSelectedId(next.profiles[0]?.id ?? "");
  };

  return (
    <div className="dialog-overlay" onClick={() => void close()}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="AI profiles"
        onClick={(e) => e.stopPropagation()}
        data-testid="profiles-dialog"
      >
        <h2 className="dialog-title">AI profiles</h2>
        <p className="dialog-lede">
          A profile steers the writing the assistant produces. It never changes how the
          assistant edits your document.
        </p>

        <div className="profiles-layout">
          <div className="profiles-list" data-testid="profiles-list">
            {list.map((p) => (
              <button
                key={p.id}
                className={`profiles-row${p.id === selectedId ? " selected" : ""}`}
                onClick={() => void select(p.id)}
              >
                <span className="profiles-row-emoji" aria-hidden="true">
                  {p.emoji}
                </span>
                <span className="profiles-row-name">{p.name}</span>
                {p.builtIn && <span className="profiles-tag">Built-in</span>}
              </button>
            ))}
            <div className="profiles-list-actions">
              <button
                className="btn-link"
                onClick={() =>
                  void act(
                    () =>
                      window.likeoffice.createProfile("New profile", "", ""),
                    true,
                  )
                }
                data-testid="profiles-new"
              >
                + New profile
              </button>
              <button
                className="btn-link muted"
                onClick={() => void act(() => window.likeoffice.restoreBuiltInProfiles(), false)}
                title="Bring back any built-in profile you deleted"
              >
                Restore built-ins
              </button>
            </div>
          </div>

          <div className="profiles-editor">
            {draft && selected ? (
              <>
                <div className="profiles-name-row">
                  <div>
                    <label className="field-label">Icon</label>
                    <input
                      className="field-input profiles-emoji-input"
                      value={draft.emoji}
                      maxLength={4}
                      readOnly={selected.builtIn}
                      placeholder="🙂"
                      onChange={(e) => setDraft({ ...draft, emoji: e.target.value })}
                      data-testid="profile-emoji"
                    />
                  </div>
                  <div className="profiles-name-field">
                    <label className="field-label">Name</label>
                    <input
                      className="field-input"
                      value={draft.name}
                      maxLength={60}
                      readOnly={selected.builtIn}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      data-testid="profile-name"
                    />
                  </div>
                </div>

                <label className="field-label">Instructions</label>
                <textarea
                  className="field-input profiles-instructions"
                  value={draft.instructions}
                  maxLength={MAX_INSTRUCTIONS}
                  readOnly={selected.builtIn}
                  placeholder="Write short, concrete sentences. Cut anything that does no work…"
                  onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                  data-testid="profile-instructions"
                />
                <div className="profiles-editor-foot">
                  <span className="field-hint profiles-count">
                    {selected.builtIn
                      ? "Built-in profile. Duplicate it to make changes."
                      : `${draft.instructions.length} / ${MAX_INSTRUCTIONS} characters`}
                  </span>
                  <button
                    className="btn-link"
                    onClick={() =>
                      void act(() => window.likeoffice.duplicateProfile(selected.id), true)
                    }
                    data-testid="profile-duplicate"
                  >
                    Duplicate
                  </button>
                  <button className="btn-link muted" onClick={() => void remove()} data-testid="profile-delete">
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <div className="profiles-empty">
                No profiles. Create one, or restore the built-ins.
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <span className="field-hint profiles-autosave">Changes save as you make them.</span>
          <button className="btn btn-primary" onClick={() => void close()}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
