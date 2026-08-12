import { app, BrowserWindow, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** A named prompt preset the user can switch between in the AI panel. Its
 * instructions steer the CONTENT the model writes; the operating contract in
 * the panel's system prompt is composed ahead of it and always wins. */
export interface Profile {
  id: string;
  name: string;
  emoji: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
  /** True for the four profiles the app ships. Not editable; duplicate to
   * edit, delete to hide, and "Restore built-ins" to bring back. */
  builtIn: boolean;
}

export interface ProfilesState {
  profiles: Profile[];
  /** "" means no profile: the base system prompt alone. */
  activeId: string;
}

/** Longer instructions crowd out the operating contract and cost tokens on
 * every round, so the store truncates rather than trusting the UI. */
export const MAX_INSTRUCTIONS = 4000;
const MAX_NAME = 60;
const MAX_EMOJI = 4;

const EPOCH = "1970-01-01T00:00:00.000Z";

function builtIn(id: string, name: string, emoji: string, instructions: string): Profile {
  return { id, name, emoji, instructions, createdAt: EPOCH, updatedAt: EPOCH, builtIn: true };
}

export const BUILT_IN_PROFILES: Profile[] = [
  builtIn(
    "builtin:critical-reviewer",
    "Critical reviewer",
    "🔍",
    `Read the document the way a demanding reviewer reads it. Name the weakest argument, the claims that stand without support, and the places where the order of the material hides the point. Prefer a targeted suggestion on the sentence that is actually broken over a wholesale rewrite of prose that works. Say plainly what is wrong and why, and put the most serious problem first, so the author knows what to fix before anything else. A few sentences of explanation are welcome here.`,
  ),
  builtIn(
    "builtin:plain-language",
    "Plain-language editor",
    "✂️",
    `Write in the plain-language tradition of legal and business prose. Keep sentences short and give each one a single idea. Make a concrete actor the subject and a strong verb the predicate. Turn nominalizations back into verbs: "make a determination" becomes "determine". Cut throat-clearing, legal doublets, and words that do no work. Keep the author's meaning and every term of art exact — simplify the prose, never the substance.`,
  ),
  builtIn(
    "builtin:academic-tightening",
    "Academic tightening",
    "🎓",
    `Tighten academic prose without flattening it. Cut hedges, filler, and repeated setup, and keep the technical vocabulary, citations, and qualifications that carry real meaning. Make each paragraph state its claim early and spend the rest of its length supporting that claim. Leave the author's voice, tense, and citation style as they are. Prefer removing words to adding them: the goal is a shorter sentence that says the same thing.`,
  ),
  builtIn(
    "builtin:fiction-editor",
    "Narrative editor",
    "📖",
    `Edit fiction with a line editor's ear. Prefer concrete images and specific nouns to abstraction, and let action and dialogue carry the weight that adverbs and stage directions try to carry. Vary the rhythm: break up long runs of same-length sentences. Trim the sentences that restate what the reader already understands. Keep the author's voice, tense, and point of view exactly as they are — you sharpen the prose, you do not rewrite it into your own style.`,
  ),
];

/** Profiles live in their own file rather than settings.json: they are a
 * growing list of multi-kilobyte texts with their own edit lifecycle, while
 * settings.json is a small fixed record rewritten whole on every save. */
function profilesFile(): string {
  return path.join(app.getPath("userData"), "profiles.json");
}

interface StoredState {
  /** User-authored profiles only. Built-ins are code, not data. */
  profiles: Profile[];
  activeId: string;
  /** Built-in ids the user deleted. "Restore built-ins" clears this. */
  hiddenBuiltIns: string[];
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function readStoredProfile(raw: Record<string, unknown>): Profile | null {
  const id = text(raw.id, 80);
  const name = text(raw.name, MAX_NAME);
  if (id === "" || name === "") return null;
  const now = new Date().toISOString();
  return {
    id,
    name,
    emoji: text(raw.emoji, MAX_EMOJI),
    instructions: text(raw.instructions, MAX_INSTRUCTIONS),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
    builtIn: false,
  };
}

async function readStored(): Promise<StoredState> {
  try {
    const raw = JSON.parse(await readFile(profilesFile(), "utf8"));
    const list = Array.isArray(raw.profiles) ? raw.profiles : [];
    return {
      profiles: list
        .map((p: unknown) => readStoredProfile((p ?? {}) as Record<string, unknown>))
        .filter((p: Profile | null): p is Profile => p !== null),
      activeId: text(raw.activeId, 80),
      hiddenBuiltIns: Array.isArray(raw.hiddenBuiltIns)
        ? raw.hiddenBuiltIns.filter((id: unknown) => typeof id === "string")
        : [],
    };
  } catch {
    return { profiles: [], activeId: "", hiddenBuiltIns: [] };
  }
}

async function writeStored(stored: StoredState): Promise<ProfilesState> {
  await writeFile(profilesFile(), JSON.stringify(stored, null, 2));
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send("profiles:changed");
  }
  return view(stored);
}

/** Built-ins first, then the user's own in creation order. An activeId that
 * points at nothing (a deleted profile) reads back as no profile. */
function view(stored: StoredState): ProfilesState {
  const profiles = [
    ...BUILT_IN_PROFILES.filter((p) => !stored.hiddenBuiltIns.includes(p.id)),
    ...stored.profiles,
  ];
  const activeId = profiles.some((p) => p.id === stored.activeId) ? stored.activeId : "";
  return { profiles, activeId };
}

export async function readProfiles(): Promise<ProfilesState> {
  return view(await readStored());
}

ipcMain.handle("profiles:list", async (): Promise<ProfilesState> => readProfiles());

ipcMain.handle(
  "profiles:create",
  async (_e, name: string, emoji: string, instructions: string): Promise<ProfilesState> => {
    const stored = await readStored();
    const now = new Date().toISOString();
    const profile: Profile = {
      id: randomUUID(),
      name: text(name, MAX_NAME) || "Untitled profile",
      emoji: text(emoji, MAX_EMOJI),
      instructions: text(instructions, MAX_INSTRUCTIONS),
      createdAt: now,
      updatedAt: now,
      builtIn: false,
    };
    stored.profiles.push(profile);
    stored.activeId = profile.id;
    return writeStored(stored);
  },
);

ipcMain.handle(
  "profiles:update",
  async (
    _e,
    id: string,
    name: string,
    emoji: string,
    instructions: string,
  ): Promise<ProfilesState> => {
    const stored = await readStored();
    const profile = stored.profiles.find((p) => p.id === id);
    if (profile) {
      profile.name = text(name, MAX_NAME) || profile.name;
      profile.emoji = text(emoji, MAX_EMOJI);
      profile.instructions = text(instructions, MAX_INSTRUCTIONS);
      profile.updatedAt = new Date().toISOString();
    }
    return writeStored(stored);
  },
);

ipcMain.handle("profiles:delete", async (_e, id: string): Promise<ProfilesState> => {
  const stored = await readStored();
  if (BUILT_IN_PROFILES.some((p) => p.id === id)) {
    if (!stored.hiddenBuiltIns.includes(id)) stored.hiddenBuiltIns.push(id);
  } else {
    stored.profiles = stored.profiles.filter((p) => p.id !== id);
  }
  if (stored.activeId === id) stored.activeId = "";
  return writeStored(stored);
});

ipcMain.handle("profiles:duplicate", async (_e, id: string): Promise<ProfilesState> => {
  const stored = await readStored();
  const source = [...BUILT_IN_PROFILES, ...stored.profiles].find((p) => p.id === id);
  if (!source) return view(stored);
  const now = new Date().toISOString();
  const copy: Profile = {
    id: randomUUID(),
    name: text(`${source.name} copy`, MAX_NAME),
    emoji: source.emoji,
    instructions: source.instructions,
    createdAt: now,
    updatedAt: now,
    builtIn: false,
  };
  stored.profiles.push(copy);
  stored.activeId = copy.id;
  return writeStored(stored);
});

ipcMain.handle("profiles:set-active", async (_e, id: string): Promise<ProfilesState> => {
  const stored = await readStored();
  stored.activeId = typeof id === "string" ? id : "";
  return writeStored(stored);
});

ipcMain.handle("profiles:restore-built-ins", async (): Promise<ProfilesState> => {
  const stored = await readStored();
  stored.hiddenBuiltIns = [];
  return writeStored(stored);
});
