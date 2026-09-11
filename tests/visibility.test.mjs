import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// Characterises the footer-visibility surface: the settings file, the command, and what
// reaches the rendered bar. Written before the WebUI removal so the refactor has a net.
const scratch = resolve(".scratch");
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, "visibility-test-"));
const settingsFile = join(dir, "visibility.json");
process.env.PMLS_SETTINGS_FILE = settingsFile;
process.env.PMLS_FETCH = "0";
process.env.PMLS_AUTO_REFRESH_MS = "0";
process.env.PMLS_DISABLE_PROMPT_ESTIMATE = "1";

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const statusbar = await createJiti(import.meta.url, { moduleCache: false }).import(resolve("extensions/statusbar/index.ts"));
const footerExtension = statusbar.default;

const origin = Date.now() - 60_000;
const session = () => {
  const path = join(dir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
  const header = { type: "session", version: 3, id: "vis", cwd: dir, timestamp: new Date(origin).toISOString() };
  const entries = [
    { role: "user", content: "hello", timestamp: origin },
    { role: "assistant", responseId: "r1", provider: "p", model: "m", api: "a", stopReason: "stop", timestamp: origin + 1000,
      content: [], usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150,
        cost: { input: 1.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 } } },
  ].map((message, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null,
    timestamp: new Date(message.timestamp).toISOString(), message }));
  writeFileSync(path, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
};

async function start({ estimate = false } = {}) {
  if (estimate) delete process.env.PMLS_DISABLE_PROMPT_ESTIMATE;
  else process.env.PMLS_DISABLE_PROMPT_ESTIMATE = "1";
  const sm = SessionManager.open(session(), dir);
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  let footer;
  const theme = { fg: (_t, text) => text, bold: (text) => text };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, spec) => commands.set(name, spec),
    registerShortcut() {},
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    getThinkingLevel: () => "off", getActiveTools: () => [], getAllTools: () => [],
  };
  const ctx = { cwd: dir, hasUI: true, mode: "tui", sessionManager: sm,
    getContextUsage: () => undefined, modelRegistry: { isUsingOAuth: () => false },
    // What pi hands an extension for the prompt it will send.
    getSystemPrompt: () => "You are a coding assistant. ".repeat(200),
    ui: { theme, notify: (text) => notices.push(text), setStatus() {},
      setFooter(factory) {
        footer = factory?.({ requestRender() {} }, theme, { onBranchChange: () => () => {},
          getGitBranch: () => null, getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map() });
      } },
  };
  footerExtension(pi);
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const render = () => footer.render(2000).join("\n");
  // Totals arrive from the worker; assert on a settled bar, never a pending one.
  const deadline = Date.now() + 10_000;
  while (render().includes("accounting …") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!render().includes("accounting …"), "accounting settled before assertions");
  return {
    notices,
    render,
    debug: () => commands.get("pmls").handler("debug", ctx),
    run: (args) => commands.get("pmls").handler(args, ctx),
    close: () => handlers.get("session_shutdown")({ reason: "quit" }, ctx),
  };
}

test("the settings file is a flat segment-to-visibility map", async () => {
  writeFileSync(settingsFile, JSON.stringify({ tokens: false, cache: false }));
  const host = await start();
  try {
    const rendered = host.render();
    assert.ok(!rendered.includes("🪙"), "tokens hidden");
    assert.ok(!rendered.includes("💾"), "cache hidden");
    assert.match(rendered, /\$1\.25/, "segments not named in the file keep their default");
  } finally { await host.close(); }
});

test("a project setting overrides the global default, widget by widget", async () => {
  const { load, writeLayer, projectFile, globalFile } = await import(resolve("extensions/statusbar/visibility.mjs"));
  const project = join(dir, "proj");
  mkdirSync(join(project, ".pi"), { recursive: true });
  const restore = process.env.PMLS_SETTINGS_FILE;
  try {
    process.env.PMLS_SETTINGS_FILE = join(dir, "global.json");
    await writeLayer(globalFile(process.env), { cost: false, tokens: false });
    await writeLayer(projectFile(project), { cost: true });

    const { state } = await load({ cwd: project });
    assert.equal(state.cost.value, true, "the project re-enables what the global hid");
    assert.equal(state.cost.source, "project", "and says which layer decided");
    assert.equal(state.tokens.value, false, "untouched keys still follow the global");
    assert.equal(state.tokens.source, "global");
    assert.equal(state.cache.value, true, "and everything else follows the built-in default");
    assert.equal(state.cache.source, "default");
  } finally {
    if (restore === undefined) delete process.env.PMLS_SETTINGS_FILE;
    else process.env.PMLS_SETTINGS_FILE = restore;
  }
});

test("the roster survives windows with different extensions, and forgets ones that are gone", async () => {
  const v = await import(resolve("extensions/statusbar/visibility.mjs"));
  const env = { PI_CODING_AGENT_DIR: join(dir, `roster-${Math.random().toString(36).slice(2)}`) };
  const day = 24 * 60 * 60 * 1000;
  const t0 = 1_000_000_000_000;

  // Two windows, each seeing only its own extensions. Replacing rather than merging would make
  // each one erase the other's names on every repaint.
  await v.writeRoster(["ponytail", "telegram"], env, t0);
  await v.writeRoster(["ponytail", "lens"], env, t0);
  assert.deepEqual(await v.readRoster(env, t0), ["lens", "ponytail", "telegram"], "nobody's names were lost");

  // A scan adds names that have never published; a later repaint must not wipe them.
  await v.writeRoster(["safe-compact"], env, t0);
  await v.writeRoster(["ponytail"], env, t0 + 1000);
  assert.ok((await v.readRoster(env, t0 + 1000)).includes("safe-compact"), "scanned names survive a repaint");

  // An extension that is uninstalled simply stops being seen, and ages out on its own.
  const later = t0 + 31 * day;
  await v.writeRoster(["ponytail"], env, later);
  const surviving = await v.readRoster(env, later);
  assert.deepEqual(surviving, ["ponytail"], "removed extensions are forgotten after the window");
});

test("an extension nobody has silenced is shown, and silence survives new arrivals", async () => {
  const v = await import(resolve("extensions/statusbar/visibility.mjs"));
  const restore = process.env.PMLS_SETTINGS_FILE;
  try {
    process.env.PMLS_SETTINGS_FILE = join(dir, "ext-global.json");
    await v.writeLayer(v.globalFile(process.env), { [v.extensionKey("ponytail")]: false });

    // The rule that matters: absent means shown, so installing an extension never requires
    // touching settings, and only an explicit "off" silences one.
    let state = v.effective({ global: await v.readLayer(v.globalFile(process.env)), extensions: ["ponytail", "telegram"] });
    assert.equal(state[v.extensionKey("ponytail")].value, false, "the silenced one stays silent");
    assert.equal(state[v.extensionKey("telegram")].value, true, "an unmentioned one shows");
    assert.equal(state[v.extensionKey("telegram")].source, "default");

    // A brand new extension arriving later must not inherit someone else's decision.
    state = v.effective({ global: await v.readLayer(v.globalFile(process.env)), extensions: ["ponytail", "telegram", "arrived-today"] });
    assert.equal(state[v.extensionKey("arrived-today")].value, true, "new arrivals are visible");

    // Reset clears dynamic switches as well as the fixed widgets.
    await v.writeLayer(v.globalFile(process.env), {});
    state = v.effective({ global: await v.readLayer(v.globalFile(process.env)), extensions: ["ponytail"] });
    assert.equal(state[v.extensionKey("ponytail")].value, true, "reset brings it back");
  } finally {
    if (restore === undefined) delete process.env.PMLS_SETTINGS_FILE;
    else process.env.PMLS_SETTINGS_FILE = restore;
  }
});

test("every widget the bar can draw is in the catalogue, with an explanation", async () => {
  const { WIDGETS, KEYS } = await import(resolve("extensions/statusbar/visibility.mjs"));
  // A widget missing here is invisible to both the command line and the in-app list.
  assert.equal(new Set(KEYS).size, KEYS.length, "no duplicate keys");
  for (const w of WIDGETS) {
    assert.ok(w.what.length > 20, `${w.key} needs a real explanation`);
    assert.ok(w.sample.length > 0, `${w.key} needs an example of what it shows`);
    assert.ok([1, 2, 3].includes(w.line), `${w.key} must say which line it is on`);
  }
});

test("a settings file in an unrecognised shape is ignored, not obeyed and not fatal", async () => {
  // The pre-1.0 shape, which nested keys under all/native/webui scopes.
  writeFileSync(settingsFile, JSON.stringify({ version: 1, overrides: { all: { tokens: false } } }));
  const host = await start();
  try {
    assert.match(host.render(), /\ud83e\ude99|🪙/, "unknown shape leaves every segment at its default");
    await host.run("hide cache");
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { cache: false }, "and the file is rewritten flat");
  } finally { await host.close(); }
});

test("the command hides and restores a segment, and persists its decision", async () => {
  writeFileSync(settingsFile, JSON.stringify({ version: 1, overrides: { all: {}, native: {}, webui: {} } }));
  const host = await start();
  try {
    assert.match(host.render(), /🪙/);
    await host.run("hide tokens");
    assert.ok(!host.render().includes("🪙"), "hidden after the command");
    assert.match(JSON.stringify(JSON.parse(readFileSync(settingsFile, "utf8"))), /"tokens":false/);
    await host.run("show tokens");
    assert.match(host.render(), /🪙/, "restored after show");
    await host.run("status");
    assert.ok(host.notices.some((n) => /tokens/.test(n)), "status reports the key");
  } finally { await host.close(); }
});

test("an unknown key is refused instead of silently ignored", async () => {
  writeFileSync(settingsFile, JSON.stringify({ version: 1, overrides: { all: {}, native: {}, webui: {} } }));
  const host = await start();
  try {
    await host.run("hide not-a-real-segment");
    assert.ok(host.notices.some((n) => /not-a-real-segment|Unknown|Usage/i.test(n)), "unknown key is reported");
    assert.match(host.render(), /🪙/, "nothing else changed");
  } finally { await host.close(); }
});

test("the prompt-overhead figure is computed live, never by exporting the conversation", async () => {
  writeFileSync(settingsFile, JSON.stringify({ version: 1, overrides: { all: {}, native: {} } }));
  const host = await start({ estimate: true });
  try {
    await host.debug();
    const report = host.notices.join("\n");
    // pi's HTML exporter reports source "export-html"; the live computation reports "direct".
    assert.ok(!report.includes("export-html"), "no exported estimate may appear");
    assert.match(report, /\(direct, settled/, "the figure is the live computation, and is final");
    assert.match(host.render(), /PI: /, "the chip still renders");
  } finally { await host.close(); }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
