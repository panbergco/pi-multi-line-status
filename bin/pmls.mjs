#!/usr/bin/env node
/**
 * `pmls` — configure the status bar from a shell or from an agent, with the same model and the
 * same files the `/pmls` command inside pi uses.
 *
 * Built for two readers at once. A person runs `pmls list` and sees each widget, an example of
 * what it puts on screen, and a sentence saying what it is. An agent runs `pmls list --json` and
 * gets the same facts as data, including which layer decided each value, so it can change one
 * setting without guessing at the rest.
 */
import { WIDGETS, KEYS, normalizeKey, load, readLayer, writeLayer, writeRoster, extensionKey, extensionName, isExtensionKey } from "../extensions/statusbar/visibility.mjs";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const args = argv.filter((a) => !a.startsWith("--"));
const verb = (args.shift() ?? "list").toLowerCase();
const scope = flags.has("--project") || flags.has("-p") ? "project" : "global";
const asJson = flags.has("--json");

const die = (message) => { console.error(`pmls: ${message}`); process.exit(2); };

const usage = `pmls — status bar widgets

  pmls list [--json]            every widget: what it shows, whether it is on, who decided
  pmls on   <widget...>         turn widgets on
  pmls off  <widget...>         turn widgets off
  pmls unset <widget...>        stop deciding here; fall back to the layer beneath
  pmls reset                    clear every choice in this layer (add --project for the project)
  pmls scan [--save]            find installed extensions and the status keys they publish
  pmls where                    which files are in use

  --project                     write to this project instead of the global default
  --json                        machine-readable output

Global default lives in the pi agent directory; a project setting lives in the project's
.pi directory and overrides the global one widget by widget.`;


/**
 * Find every extension pi is configured to load and the status keys it publishes, without running
 * pi at all. The roster only knows who has already spoken; this finds the quiet ones too, so a
 * status can be switched off before it ever appears.
 *
 * Keys are read from literal `setStatus("name", …)` calls. A key built at runtime cannot be known
 * from the file, and is reported as such rather than guessed at.
 */
async function scanInstalledExtensions(cwd) {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const roots = new Set();
  const looked = { agentDir, settings: [], missing: [] };

  const addFromSettings = async (file) => {
    try {
      const settings = JSON.parse(await readFile(file, "utf8"));
      for (const pkg of settings.packages ?? []) {
        const source = typeof pkg === "string" ? pkg : pkg?.source;
        if (!source) continue;
        if (source.startsWith("git:")) roots.add(join(dirname(file), "git", source.slice(4).replace(/^https?:\/\//, "")));
        else if (source.startsWith("npm:")) roots.add(join(dirname(file), "npm", "node_modules", source.slice(4)));
        else roots.add(resolvePath(dirname(file), source));
      }
      looked.settings.push(file);
    } catch { looked.missing.push(file); }
  };
  await addFromSettings(join(agentDir, "settings.json"));
  await addFromSettings(join(cwd, ".pi", "settings.json"));
  roots.add(join(agentDir, "extensions"));
  roots.add(join(cwd, ".pi", "extensions"));

  const files = [];
  const walk = async (dir, depth = 0) => {
    if (depth > 3 || !existsSync(dir)) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) files.push(full);
    }
  };
  for (const root of roots) await walk(root);

  const found = new Map();
  for (const file of files) {
    let text = "";
    try { text = await readFile(file, "utf8"); } catch { continue; }
    if (!text.includes("setStatus")) continue;
    const literals = [...text.matchAll(/setStatus\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    const dynamic = /setStatus\(\s*[^"'`)\s]/.test(text);
    if (literals.length === 0 && !dynamic) continue;
    const owner = file.replace(homedir(), "~");
    for (const key of literals) {
      if (!found.has(key)) found.set(key, { key, owner, dynamic: false });
    }
    if (literals.length === 0) found.set(`(dynamic) ${owner}`, { key: null, owner, dynamic: true });
  }
  return { entries: [...found.values()], looked, scannedFiles: files.length };
}

const { globalFile, projectFile, global, project, state, extensions } = await load();
const file = scope === "project" ? projectFile : globalFile;

const resolveKeys = (tokens) => tokens.map((t) => {
  const key = normalizeKey(t, extensions);
  if (!key) die(`unknown widget "${t}". Run "pmls list" to see them all.`);
  return key;
});

const edit = async (change) => {
  const layer = { ...(await readLayer(file)) };
  change(layer);
  const written = await writeLayer(file, layer);
  if (asJson) console.log(JSON.stringify({ scope, file, layer: written }, null, 2));
  else {
    console.log(`${scope === "project" ? "Project" : "Global"} setting saved · ${file}`);
    const decided = Object.entries(written);
    console.log(decided.length ? decided.map(([k, v]) => `  ${k}: ${v ? "on" : "off"}`).join("\n") : "  (nothing set here; the layer beneath decides)");
  }
};

switch (verb) {
  case "list": {
    if (asJson) {
      console.log(JSON.stringify({
        globalFile, projectFile,
        widgets: WIDGETS.map((w) => ({ ...w, on: state[w.key].value, decidedBy: state[w.key].source })),
        extensions: extensions.map((name) => ({
          key: extensionKey(name), name, line: 3,
          what: `Status text published by the ${name} extension`,
          on: (state[extensionKey(name)] ?? { value: true }).value,
          decidedBy: (state[extensionKey(name)] ?? { source: "default" }).source,
        })),
      }, null, 2));
      break;
    }
    console.log(`Status bar widgets · global ${globalFile}\n                   · project ${projectFile}\n`);
    let line = 0;
    for (const w of WIDGETS) {
      if (w.line !== line) { line = w.line; console.log(`  ── line ${line} ${"─".repeat(46)}`); }
      const { value, source } = state[w.key];
      const mark = value ? "[x]" : "[ ]";
      const from = source === "default" ? "" : ` (set in ${source})`;
      console.log(`  ${mark} ${w.key.padEnd(22)} ${w.sample}`);
      console.log(`      ${w.what}${from}`);
    }
    if (extensions.length > 0) {
      console.log(`  ── line 3 · other extensions ${"─".repeat(33)}`);
      for (const name of extensions) {
        const decided = state[extensionKey(name)] ?? { value: true, source: "default" };
        const from = decided.source === "default" ? "" : ` (set in ${decided.source})`;
        console.log(`  ${decided.value ? "[x]" : "[ ]"} ${name.padEnd(22)} status text published by ${name}${from}`);
      }
    } else {
      console.log(`  ── line 3 · other extensions ${"─".repeat(33)}`);
      console.log(`      (none seen yet — start pi once with this bar and they will be listed)`);
    }
    console.log(`\n  pmls off <widget>            hide it everywhere`);
    console.log(`  pmls off <widget> --project  hide it only in this project`);
    break;
  }
  case "on": case "show":
    if (!args.length) die("name at least one widget");
    await edit((l) => { for (const k of resolveKeys(args)) l[k] = true; });
    break;
  case "off": case "hide":
    if (!args.length) die("name at least one widget");
    await edit((l) => { for (const k of resolveKeys(args)) l[k] = false; });
    break;
  case "unset":
    if (!args.length) die("name at least one widget");
    await edit((l) => { for (const k of resolveKeys(args)) delete l[k]; });
    break;
  case "reset":
    await edit((l) => { for (const k of Object.keys(l)) delete l[k]; });
    break;
  case "scan": {
    const { entries: found, looked, scannedFiles } = await scanInstalledExtensions(process.cwd());
    const literal = found.filter((f) => f.key && f.key !== "tps" && f.key !== "pmls");
    if (asJson) {
      console.log(JSON.stringify({ found: literal, unknown: found.filter((f) => f.dynamic), roster: extensions, looked, scannedFiles }, null, 2));
      break;
    }
    console.log(`Scanned ${scannedFiles} file(s) from ${looked.settings.length || "no"} settings file(s).`);
    for (const file of looked.settings) console.log(`  read   ${file.replace(homedir(), "~")}`);
    // An empty result has two very different causes; saying which one saves a hunt.
    for (const file of looked.missing) console.log(`  absent ${file.replace(homedir(), "~")}`);
    console.log("");
    if (literal.length === 0) {
      console.log(looked.settings.length === 0
        ? "  nothing to scan: no pi settings file was found, so no extensions are configured here"
        : "  no extension publishes a status key by a literal name");
    }
    for (const f of literal) {
      const decided = state[extensionKey(f.key)] ?? { value: true, source: "default" };
      const seen = extensions.includes(f.key.toLowerCase()) ? "" : "  (not published yet)";
      console.log(`  ${decided.value ? "[x]" : "[ ]"} ${f.key.padEnd(20)} ${f.owner}${seen}`);
    }
    for (const f of found.filter((x) => x.dynamic)) console.log(`  [?] key decided at runtime   ${f.owner}`);
    if (flags.has("--save")) {
      const merged = await writeRoster([...extensions, ...literal.map((f) => f.key)]);
      console.log(`\n  remembered ${merged.length} name(s); they now appear in "pmls list" and in /pmls`);
    } else {
      console.log(`\n  add --save to make these configurable before they ever publish`);
    }
    break;
  }
  case "where":
    if (asJson) console.log(JSON.stringify({ globalFile, projectFile, global, project }, null, 2));
    else {
      console.log(`global  ${globalFile}${Object.keys(global).length ? "" : "  (nothing set)"}`);
      console.log(`project ${projectFile}${Object.keys(project).length ? "" : "  (nothing set)"}`);
    }
    break;
  case "help": case "--help": case "-h":
    console.log(usage);
    break;
  default:
    die(`unknown command "${verb}"\n\n${usage}`);
}
