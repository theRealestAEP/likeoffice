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
  /** One line for the picker. */
  description: string;
  /** Shown in the manage dialog. Where a profile applies a named authority's
   * published method, this names the source and says the app has no
   * affiliation with them. "" for the profiles that name nobody. */
  disclaimer: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
  /** True for the profiles the app ships. Not editable; duplicate to edit,
   * delete to hide, and "Restore built-ins" to bring back. */
  builtIn: boolean;
}

/** An extra profile the app ships but does not list until the user adds it.
 * Only what the "Add more profiles…" picker draws. */
export interface ExtraProfile {
  id: string;
  name: string;
  emoji: string;
  description: string;
}

export interface ProfilesState {
  profiles: Profile[];
  /** "" means no profile: the base system prompt alone. */
  activeId: string;
  /** The shipped extras the user has not added yet. */
  extras: ExtraProfile[];
}

/** Longer instructions crowd out the operating contract and cost tokens on
 * every round, so the store truncates rather than trusting the UI. */
export const MAX_INSTRUCTIONS = 4000;
const MAX_NAME = 60;
const MAX_EMOJI = 4;
const MAX_NOTE = 200;

const EPOCH = "1970-01-01T00:00:00.000Z";

function builtIn(
  id: string,
  name: string,
  emoji: string,
  description: string,
  disclaimer: string,
  instructions: string,
): Profile {
  return {
    id,
    name,
    emoji,
    description,
    disclaimer,
    instructions,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    builtIn: true,
  };
}

/** A library of writing methods, each named for the guide or authority it
 * applies. A profile that names a person or a publisher carries a disclaimer
 * naming the source and stating we have no affiliation with them. The
 * instructions restate published principles in our own words: no profile
 * reproduces anyone's text, and none of them speaks as anyone.
 *
 * The list ships short on purpose: five profiles that between them cover
 * substance, mechanics, a professional domain, sentence-level style, and
 * document structure. The rest of the library is EXTRA_PROFILES below, which
 * the manage dialog adds on request. */
export const BUILT_IN_PROFILES: Profile[] = [
  builtIn(
    "builtin:critical-reviewer",
    "Critical reviewer",
    "🔍",
    "Names the weakest argument and the unsupported claims first.",
    "",
    `Read the document the way a demanding reviewer reads it. Name the weakest argument, the claims that stand without support, and the places where the order of the material hides the point. Prefer a targeted suggestion on the sentence that is actually broken over a wholesale rewrite of prose that works. Say plainly what is wrong and why, and put the most serious problem first, so the author knows what to fix before anything else. A few sentences of explanation are welcome here.`,
  ),
  builtIn(
    "builtin:copyedit",
    "Copyedit only",
    "📝",
    "Grammar, punctuation and consistency. No rewriting for style.",
    "",
    `Copyedit only. Fix grammar, spelling, punctuation, subject-verb agreement, tense agreement, and pronoun reference. Make usage consistent across the document: one spelling of each word, one form of each name, and one convention for numbers, dates, hyphens, and capitals — follow whichever form the author already uses most. Repair mechanical faults such as comma splices, run-on sentences, dangling modifiers, and unclosed quotation marks or parentheses. Leave word choice, sentence order, paragraph order, and content alone, even where you would write them differently. If a sentence reads badly but breaks no rule, keep it and say so in your reply rather than rewriting it. Preserve the author's voice, register, dialect, and every term of art exactly.`,
  ),
  builtIn(
    "builtin:garner-legal",
    "Garner legal review",
    "⚖️",
    "Plain-English legal editing, from Bryan Garner's published method.",
    "Applies principles from Bryan Garner's Legal Writing in Plain English and Garner's Modern English Usage. LikeOffice is not affiliated with or endorsed by Bryan Garner.",
    `Edit legal prose with the plain-English method Bryan Garner sets out in Legal Writing in Plain English and Garner's Modern English Usage, restated here in our own words. Put the point first: give the conclusion or the issue in the opening sentence, then the support. Give each sentence a concrete actor as its subject and a strong verb as its predicate, and hold the average sentence near 20 words. Turn nominalizations back into the verbs they came from: "make a determination" becomes "determine", and "is in violation of" becomes "violates". Cut legalese and doublets: "pursuant to" becomes "under", "prior to" becomes "before", and "null and void" becomes "void". Delete throat-clearing openers such as "It should be noted that", and keep the passive voice only where the actor is genuinely unknown or beside the point. Preserve every defined term, citation, cross-reference, and term of art exactly as written — simplify the prose, never the substance.`,
  ),
  builtIn(
    "builtin:strunk-white",
    "Strunk & White concision",
    "✂️",
    "Omit needless words, active voice, parallel form.",
    "Applies principles from Strunk and White's The Elements of Style. LikeOffice is not affiliated with or endorsed by its authors, their estates, or its publisher.",
    `Tighten prose with the concision principles of Strunk and White's The Elements of Style, restated here in our own words. Omit needless words: replace a phrase with the single word that carries it, so "the question as to whether" becomes "whether" and "owing to the fact that" becomes "because". Use the active voice, and put the actor in front of the verb. Express parallel ideas in parallel form, including the items of a list and the halves of a paired clause. Place the emphatic word or phrase at the end of the sentence, where it lands. Prefer definite, specific, concrete language to the vague and abstract, and prefer the positive form of a statement to the negative. Keep related words together so the reader never has to reassemble the sentence.`,
  ),
  builtIn(
    "builtin:minto-pyramid",
    "Minto pyramid brief",
    "🔺",
    "Answer first, then grouped arguments, then the data.",
    "Applies the method Barbara Minto published as The Pyramid Principle. LikeOffice is not affiliated with or endorsed by Barbara Minto.",
    `Structure the writing the way Barbara Minto's Pyramid Principle describes, restated here in our own words. Lead with the answer: the single governing thought the reader needs, in the first two or three sentences. Support that answer with three to five arguments that are mutually exclusive and collectively exhaustive — no overlap between them, and nothing important left outside them. Order the arguments deliberately, by time, by structure, or by importance, and keep that order consistent down the document. Put data, exhibits, and detail one level below the argument they support, never above it. Write each heading as a full sentence that states its point, so a reader who reads only the headings still gets the whole argument. Where the piece needs an opening, give the situation and the complication the reader already accepts, then the question they are asking, and only then the answer.`,
  ),
];

/** The rest of the shipped library, off the list until the user asks for it.
 * "Add more profiles…" in the manage dialog puts one in the picker, and
 * deleting it takes it back out, so nothing here is ever lost. Each keeps its
 * own disclaimer. */
export const EXTRA_PROFILES: Profile[] = [
  builtIn(
    "builtin:plain-language",
    "Plain-language public writing",
    "🏛️",
    "Federal plain-writing practice: you-voice, headings, short sections.",
    "",
    `Write for the general public under the plain-language rules the Plain Writing Act and the federal plain-language guidelines set out. Address the reader as "you" and call the organization "we", so every requirement says plainly who must do what. Put the most useful information first, and tell the reader what to do before you explain the background. Break the text into short sections under headings written as the reader's own question, such as "How do I apply?". Hold paragraphs to three or four sentences and sentences to about 20 words, with one idea in each. Use everyday words in place of jargon, and define a term of art the first time you must use it. Turn conditions, exceptions, and steps into bulleted or numbered lists instead of long sentences full of clauses.`,
  ),
  builtIn(
    "builtin:zinsser",
    "Zinsser nonfiction",
    "🖋️",
    "Clutter-free nonfiction that keeps a human voice.",
    "Applies principles from William Zinsser's On Writing Well. LikeOffice is not affiliated with or endorsed by his estate or his publisher.",
    `Edit nonfiction with the principles William Zinsser sets out in On Writing Well, restated here in our own words. Strip clutter: the adverb the verb already carries, the adjective the noun already carries, qualifiers such as "a bit" and "sort of", and padding such as "at this point in time". Hold one person, one tense, and one point of view for the length of the piece. Make the first sentence earn the second and the second earn the third, and end the moment the reader has what they came for — often on a short final sentence. Prefer short, plain words to long Latinate ones, and keep the warmth and the particular humanity of the author's own voice. Trust the reader: state the fact and move on instead of explaining what the fact means.`,
  ),
  builtIn(
    "builtin:chicago",
    "Chicago editorial pass",
    "📚",
    "CMOS numbers, hyphens, capitals and citation style.",
    "Follows conventions published in The Chicago Manual of Style. LikeOffice is not affiliated with or endorsed by the University of Chicago Press.",
    `Edit to the conventions The Chicago Manual of Style publishes. Spell out whole numbers from one through one hundred and round numbers above that; use numerals for percentages, measurements, money, and anything larger. Capitalize titles of works headline-style: the first and last words, and every noun, pronoun, verb, adjective, adverb, and subordinating conjunction. Hyphenate a compound modifier before its noun, leave it open after the noun, and leave an adverb ending in -ly open in either position. Use the serial comma, set em dashes closed up to the words around them, and put periods and commas inside closing quotation marks. Keep one citation system throughout — notes-bibliography or author-date — and match whichever the author already uses rather than converting it. Where the manual leaves a choice to the author, say what the options are instead of deciding it silently.`,
  ),
  builtIn(
    "builtin:ap-style",
    "AP style news",
    "📰",
    "AP conventions, inverted pyramid, tight attribution.",
    "Follows conventions published in the AP Stylebook. LikeOffice is not affiliated with or endorsed by The Associated Press.",
    `Write and edit to Associated Press style. Lead with the news: put the most important fact in a first sentence of about 30 words, then the supporting facts in falling order of importance, so an editor can cut from the bottom. Attribute every fact that is not common knowledge, name the source, and use "said" rather than a characterizing verb such as "admitted" or "claimed". Spell out one through nine and use figures for 10 and above; abbreviate the long months when a date follows; give a person's full name on first reference and the last name after. Skip the serial comma in a simple series, lowercase a job title that follows a name, and keep paragraphs to one or two sentences. Keep the writing neutral: report what people said and did, and leave the conclusion to the reader.`,
  ),
  builtIn(
    "builtin:imrad",
    "IMRaD academic",
    "🎓",
    "Introduction, Methods, Results, Discussion — hedged to the evidence.",
    "",
    `Edit research writing to the IMRaD structure and its conventions. Hold each section to its job: the introduction moves from the field to the gap to this study's question; the methods say what was done in enough detail to repeat it; the results report findings without interpreting them; the discussion interprets, compares with prior work, and states the limits. Write the methods in the past tense and settled knowledge in the present tense. Match every hedge to the evidence — "shows" for a direct result, "suggests" for an indirect one, "may" for a possibility — and collapse hedges stacked on hedges such as "may possibly suggest". Report an effect with its magnitude and its uncertainty, not only its direction or a bare p-value. Keep causal language out of the results of an observational design. Leave the author's citation style, reference list, and technical vocabulary exactly as they are.`,
  ),
  builtIn(
    "builtin:technical-docs",
    "Technical documentation",
    "🛠️",
    "Imperative steps, second person, present tense.",
    "Follows the public Google and Microsoft developer style guides. LikeOffice is not affiliated with or endorsed by Google or Microsoft.",
    `Write developer documentation the way the public Google and Microsoft developer style guides describe. Address the reader as "you", and write every instruction as an imperative: "Run the command", not "The command should be run". Use the present tense: "the server returns 404", not "the server will return 404". Give one action per numbered step, and name the location before the action, so the reader knows where to look before they act. Show what the result looks like when the reader needs it to confirm the step worked, and put a warning before the step it applies to, never after. Use one term for one thing every time, and cut "simply", "just", and "easy". Write link text that names its destination, and reproduce code identifiers, casing, and file paths exactly as the product spells them.`,
  ),
  builtIn(
    "builtin:grant-proposal",
    "Grant proposal",
    "🎯",
    "Need, approach, capacity, measurable outcomes.",
    "",
    `Write and edit proposals in the order a reviewer scores them: need, approach, capacity, outcomes, budget. State the need with a specific population in a specific place, and evidence a reviewer can check — a cited figure beats an adjective. Describe the approach as concrete activities: who runs each one, how often, and for how many people. Show capacity with the track record, the staff qualifications, and the partners who have already committed in writing. Write each outcome as a measurable statement: what changes, for whom, by how much, by when, and how you will measure it. Mirror the funder's own vocabulary and stated priorities, and answer every part of a prompt in the order the prompt asks it. Cut mission-statement language that makes a claim no reviewer can verify.`,
  ),
  builtIn(
    "builtin:narrative-craft",
    "Narrative craft",
    "📖",
    "Scene over summary, concrete detail, dialogue with subtext.",
    "",
    `Edit fiction and narrative nonfiction for craft rather than taste. Turn summary into scene wherever the moment matters: give it a place, a time, a body in motion, and let it play out at the pace the characters live it. Ground the reader in specific detail through the point-of-view character's senses, and cut the detail that character would not notice. Let dialogue carry subtext — a character answers a different question, changes the subject, or says less than they mean — and keep the speech tag at "said". Cut filter words such as "she felt", "he saw", and "she realized", and hand the reader the perception directly. Vary the rhythm: a short sentence after a long one lands the beat, and long runs of equal-length sentences flatten it. Keep the author's voice, tense, and point of view exactly as they are.`,
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
  /** Extra ids the user added from the library. Deleting one takes it back
   * out, so this list alone says which extras are on the picker. */
  addedExtras: string[];
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id: unknown): id is string => typeof id === "string") : [];
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
    description: text(raw.description, MAX_NOTE),
    disclaimer: text(raw.disclaimer, MAX_NOTE),
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
      hiddenBuiltIns: ids(raw.hiddenBuiltIns),
      addedExtras: ids(raw.addedExtras),
    };
  } catch {
    return { profiles: [], activeId: "", hiddenBuiltIns: [], addedExtras: [] };
  }
}

async function writeStored(stored: StoredState): Promise<ProfilesState> {
  await writeFile(profilesFile(), JSON.stringify(stored, null, 2));
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send("profiles:changed");
  }
  return view(stored);
}

/** Built-ins first, then the extras the user added, then the user's own in
 * creation order. An activeId that points at nothing (a deleted profile)
 * reads back as no profile. */
function view(stored: StoredState): ProfilesState {
  const profiles = [
    ...BUILT_IN_PROFILES.filter((p) => !stored.hiddenBuiltIns.includes(p.id)),
    ...EXTRA_PROFILES.filter((p) => stored.addedExtras.includes(p.id)),
    ...stored.profiles,
  ];
  const activeId = profiles.some((p) => p.id === stored.activeId) ? stored.activeId : "";
  const extras = EXTRA_PROFILES.filter((p) => !stored.addedExtras.includes(p.id)).map(
    ({ id, name, emoji, description }) => ({ id, name, emoji, description }),
  );
  return { profiles, activeId, extras };
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
      description: "",
      disclaimer: "",
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

/** Put a profile from the extra library on the picker, and select it. */
ipcMain.handle("profiles:add-extra", async (_e, id: string): Promise<ProfilesState> => {
  const stored = await readStored();
  if (!EXTRA_PROFILES.some((p) => p.id === id)) return view(stored);
  if (!stored.addedExtras.includes(id)) stored.addedExtras.push(id);
  stored.activeId = id;
  return writeStored(stored);
});

ipcMain.handle("profiles:delete", async (_e, id: string): Promise<ProfilesState> => {
  const stored = await readStored();
  if (BUILT_IN_PROFILES.some((p) => p.id === id)) {
    if (!stored.hiddenBuiltIns.includes(id)) stored.hiddenBuiltIns.push(id);
  } else if (EXTRA_PROFILES.some((p) => p.id === id)) {
    // An extra goes back to the "Add more profiles…" list, not away.
    stored.addedExtras = stored.addedExtras.filter((extra) => extra !== id);
  } else {
    stored.profiles = stored.profiles.filter((p) => p.id !== id);
  }
  if (stored.activeId === id) stored.activeId = "";
  return writeStored(stored);
});

ipcMain.handle("profiles:duplicate", async (_e, id: string): Promise<ProfilesState> => {
  const stored = await readStored();
  const source = [...BUILT_IN_PROFILES, ...EXTRA_PROFILES, ...stored.profiles].find(
    (p) => p.id === id,
  );
  if (!source) return view(stored);
  const now = new Date().toISOString();
  const copy: Profile = {
    id: randomUUID(),
    name: text(`${source.name} copy`, MAX_NAME),
    emoji: source.emoji,
    // The copy keeps both notes, so a copy of a named method carries its
    // "not affiliated" line with it.
    description: source.description,
    disclaimer: source.disclaimer,
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
