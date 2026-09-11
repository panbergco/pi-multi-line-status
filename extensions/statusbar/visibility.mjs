/**
 * The catalogue of status-bar widgets and where their on/off state is stored.
 *
 * ONE SOURCE OF TRUTH, TWO FRONT DOORS. The extension and the `pmls` command line both read and
 * write through here, so a widget cannot exist in one surface and not the other, and a key can
 * never mean different things in each. Plain JavaScript on purpose: the command line must run
 * without a TypeScript loader.
 *
 * Two layers, mirroring how pi itself handles settings: a global default in the agent directory,
 * and a per-project override in the project's own `.pi` directory. The project layer wins key by
 * key, so a project can hide one widget without restating the rest.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Every widget, in the order it appears on the bar, with what it actually shows. */
export const WIDGETS = [
  { key: "model", line: 1, sample: "⬢ anthropic Claude Opus 4.5 200k context v0.85.1", what: "Which model is answering, its context size, and the pi version." },
  { key: "thinking", line: 1, sample: "medium", what: "The reasoning effort the model is set to." },
  { key: "cwd", line: 1, sample: "📁 ~/src/my-project", what: "The directory this session is working in." },
  { key: "cwd-branch", line: 1, sample: "⎇ main", what: "The Git branch beside the directory." },
  { key: "git-status", line: 1, sample: "⎇ main · ✅", what: "The whole Git block. Turning this off hides every git-* widget below." },
  { key: "git-branch-indicator", line: 1, sample: "⎇ main", what: "The branch name itself." },
  { key: "git-detached", line: 1, sample: "detached", what: "A warning that HEAD is not on a branch." },
  { key: "git-operation", line: 1, sample: "rebasing", what: "An interrupted operation in progress: merge, rebase, cherry-pick, bisect." },
  { key: "git-ahead", line: 1, sample: "⇡3", what: "Commits you have that the remote does not." },
  { key: "git-behind", line: 1, sample: "⇣2", what: "Commits the remote has that you do not." },
  { key: "git-upstream", line: 1, sample: "no upstream", what: "A note when the branch tracks nothing." },
  { key: "git-staged", line: 1, sample: "●4", what: "Files staged for the next commit." },
  { key: "git-unstaged", line: 1, sample: "✎6", what: "Tracked files changed but not staged." },
  { key: "git-untracked", line: 1, sample: "◌12", what: "Files Git has never seen." },
  { key: "git-conflicted", line: 1, sample: "✖1", what: "Files with unresolved merge conflicts." },
  { key: "git-clean", line: 1, sample: "✅", what: "The tick shown when nothing is changed." },
  { key: "git-stash", line: 1, sample: "⚑2", what: "How many stashes are saved." },
  { key: "git-submodules", line: 1, sample: "⊞3", what: "Submodules that are out of date or modified." },
  { key: "git-worktrees", line: 1, sample: "📦4", what: "How many worktrees this repository has." },
  { key: "git-tag", line: 1, sample: "🏷 v1.2.0", what: "A tag pointing at the current commit." },
  { key: "git-last-commit-age", line: 1, sample: "⏱2h", what: "How long ago the last commit was made." },
  { key: "git-signing-mismatch", line: 1, sample: "⚠ unsigned", what: "A warning when signing is configured but the last commit is not signed." },
  { key: "speed", line: 1, sample: "⚡ 110k tok @ 20.7 tok/s", what: "Output produced and how fast it is arriving right now." },
  { key: "speed-avg", line: 1, sample: "avg 31", what: "Average speed across this session. Off by default." },
  { key: "speed-low", line: 1, sample: "min 12", what: "Slowest measured speed this session. Off by default." },
  { key: "speed-max", line: 1, sample: "max 58", what: "Fastest measured speed this session. Off by default." },
  { key: "context", line: 2, sample: "▣ context ████ 414k/1.1M (39%)", what: "How much of the model's context window this conversation fills." },
  { key: "cost", line: 2, sample: "⊙ active 4.1h / $79.00 / +1771−66", what: "Money and lines changed: this session, this run, and the parent chain." },
  { key: "tokens", line: 2, sample: "🪙 ↑2.2M · ↓110k", what: "Tokens sent and received over the whole session." },
  { key: "cache", line: 2, sample: "💾 R68M · W0", what: "Cached tokens read and written — the cheap part of the bill." },
  { key: "pi", line: 2, sample: "PI: 25k tok", what: "Tokens spent on the system prompt and tool definitions before you type anything." },
  { key: "usage", line: 2, sample: "📊 weekly 2% · secondary 0%", what: "Subscription quota used, when the provider reports it. Nothing appears on pay-as-you-go keys." },
  { key: "extension-statuses", line: 3, sample: "◆ 23 checkpoints · MCP: 4 servers", what: "The third line as a whole. Individual extensions on it have their own switches." },
  { key: "line3-gap", line: 3, sample: "(a blank row above line 3)", what: "A blank row between the meters and the other extensions' line. Off by default; costs one row of terminal." },
];

export const KEYS = WIDGETS.map((w) => w.key);

/**
 * Line 3 belongs to other extensions, and which ones exist is only knowable while pi is running.
 * Their switches are therefore dynamic keys, `ext:<name>`, stored in the same two layers as
 * everything else. Absent means shown: a newly installed extension appears without asking, and
 * only an explicit "off" silences it — so nobody loses a status they never chose to hide.
 */
export const EXTENSION_KEY_PREFIX = "ext:";
export const isExtensionKey = (key) => String(key ?? "").startsWith(EXTENSION_KEY_PREFIX);
export const extensionKey = (name) => `${EXTENSION_KEY_PREFIX}${String(name).trim().toLowerCase()}`;
export const extensionName = (key) => String(key).slice(EXTENSION_KEY_PREFIX.length);

/**
 * The roster of extensions seen publishing a status, written by the running bar so that the
 * command line — which lives outside pi and cannot ask it anything — can still list them by name.
 */
export function rosterFile(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return resolve(agentDir, "pmls-extensions.json");
}

/** A name unseen for this long is assumed gone, and stops being offered as configurable. */
export const ROSTER_FORGET_MS = 30 * 24 * 60 * 60 * 1000;

/** `{ name: lastSeenEpochMs }`. Timestamps are what let a removed extension disappear by itself. */
export async function readRosterEntries(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(rosterFile(env), "utf8"));
    if (Array.isArray(parsed)) return Object.fromEntries(parsed.filter((x) => typeof x === "string").map((n) => [n, 0]));
    if (parsed && typeof parsed === "object") {
      const out = {};
      for (const [name, at] of Object.entries(parsed)) if (typeof at === "number") out[name] = at;
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

export async function readRoster(env = process.env, now = Date.now()) {
  const entries = await readRosterEntries(env);
  return Object.entries(entries)
    .filter(([, at]) => at === 0 || now - at < ROSTER_FORGET_MS)
    .map(([name]) => name)
    .sort();
}

/**
 * MERGE, NEVER REPLACE. Each pi window sees only the extensions loaded in it, and a scan sees ones
 * that have never spoken; if any writer replaced the file, the others' names would vanish and
 * reappear on every repaint. Merging keeps one shared view, and the timestamp is what eventually
 * removes an extension that is genuinely gone.
 */
export async function writeRoster(names, env = process.env, now = Date.now()) {
  const file = rosterFile(env);
  const entries = await readRosterEntries(env);
  for (const raw of names) {
    const name = String(raw).trim().toLowerCase();
    if (name) entries[name] = now;
  }
  for (const [name, at] of Object.entries(entries)) {
    if (at !== 0 && now - at >= ROSTER_FORGET_MS) delete entries[name];
  }
  const ordered = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  await rename(temp, file);
  return Object.keys(ordered);
}

/** Widgets that start hidden because most people do not want them. */
export const DEFAULTS = Object.freeze({ "speed-avg": false, "speed-low": false, "speed-max": false, "line3-gap": false });

const ALIASES = Object.freeze({
  branch: "git-branch-indicator", ahead: "git-ahead", behind: "git-behind", staged: "git-staged",
  unstaged: "git-unstaged", untracked: "git-untracked", conflicted: "git-conflicted",
  clean: "git-clean", stash: "git-stash", submodules: "git-submodules", worktrees: "git-worktrees",
  tag: "git-tag", "commit-age": "git-last-commit-age", signing: "git-signing-mismatch",
  git: "git-status", dir: "cwd", directory: "cwd", quota: "usage", prompt: "pi",
});

/** Resolve a user-typed token to a real key, or null. Case and separators are forgiving. */
export function normalizeKey(token, knownExtensions = []) {
  const t = String(token ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (KEYS.includes(t)) return t;
  if (isExtensionKey(t)) return t;
  // A bare extension name is accepted too, so "pmls off ponytail" does the obvious thing.
  if (knownExtensions.includes(t)) return extensionKey(t);
  return ALIASES[t] ?? null;
}

export function globalFile(env = process.env) {
  const explicit = env.PMLS_SETTINGS_FILE?.trim();
  if (explicit) return resolve(explicit);
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return resolve(agentDir, "pmls-visibility.json");
}

/**
 * The project file lives in the project's own `.pi` directory, the same place pi keeps project
 * settings, so it travels with the repository and can be committed for a team.
 * Found by walking up from the working directory to the first `.pi` or `.git` it sees.
 */
export function projectFile(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".pi")) || existsSync(join(dir, ".git"))) return join(dir, ".pi", "pmls-visibility.json");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return join(resolve(cwd), ".pi", "pmls-visibility.json");
}

/** A stored layer: `{ "cost": false }`. Anything else in the file is ignored, never obeyed. */
export async function readLayer(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = normalizeKey(k);
      if (key && typeof v === "boolean") out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Written atomically: a half-written settings file would silently change what you see. */
export async function writeLayer(file, layer) {
  const clean = {};
  for (const key of KEYS) if (typeof layer[key] === "boolean") clean[key] = layer[key];
  for (const [key, value] of Object.entries(layer)) if (isExtensionKey(key) && typeof value === "boolean") clean[key] = value;
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  await rename(temp, file);
  return clean;
}

/** Environment overrides: PMLS_HIDE=cost,context and PMLS_COST=0. */
export function envLayer(env = process.env) {
  const out = {};
  for (const token of String(env.PMLS_HIDE ?? "").split(/[,\s]+/).filter(Boolean)) {
    const key = normalizeKey(token);
    if (key) out[key] = false;
  }
  for (const key of KEYS) {
    const raw = env[`PMLS_${key.toUpperCase().replace(/-/g, "_")}`];
    if (raw !== undefined) out[key] = !/^(0|false|off|no)$/i.test(raw.trim());
  }
  return out;
}

/**
 * What each widget actually resolves to, and which layer decided it. Precedence, weakest first:
 * built-in default, environment, global file, project file. Reporting the deciding layer is the
 * point — "off" without "set where" is the kind of answer that sends people hunting.
 */
export function effective({ global = {}, project = {}, env = {}, extensions = [] } = {}) {
  const out = {};
  const all = [...KEYS, ...extensions.map(extensionKey)];
  for (const key of all) {
    let value = DEFAULTS[key] ?? true;
    let source = "default";
    if (env[key] !== undefined) { value = env[key]; source = "environment"; }
    if (global[key] !== undefined) { value = global[key]; source = "global"; }
    if (project[key] !== undefined) { value = project[key]; source = "project"; }
    out[key] = { value, source };
  }
  return out;
}

/** Everything the two front doors need, in one call. */
export async function load({ cwd = process.cwd(), env = process.env, extensions } = {}) {
  const gFile = globalFile(env);
  const pFile = projectFile(cwd);
  const [global, project, seen] = await Promise.all([readLayer(gFile), readLayer(pFile), readRoster(env)]);
  const known = extensions ?? seen;
  return { globalFile: gFile, projectFile: pFile, global, project, env: envLayer(env), extensions: known,
    state: effective({ global, project, env: envLayer(env), extensions: known }) };
}
