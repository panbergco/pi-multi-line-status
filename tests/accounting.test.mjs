import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";

// Exercise the extension's session lifecycle and rendered footer with real session files.
// Only the host UI/commands are stubbed; history loading and worker IPC stay real.
const scratch = resolve(".scratch");
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, "accounting-test-"));
process.env.PMLS_SETTINGS_FILE = join(dir, "visibility.json");
process.env.PMLS_FETCH = "0";
process.env.PMLS_AUTO_REFRESH_MS = "0";
process.env.PMLS_DISABLE_PROMPT_ESTIMATE = "1";
// Use pi's installed TypeScript loader (its utility dependency ships TypeScript too).
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const footerExtension = await createJiti(import.meta.url, { moduleCache: false }).import(resolve(process.env.FOOTER_TEST_ENTRY ?? "extensions/statusbar/index.ts"), { default: true });
const { StatusWorker } = await createJiti(import.meta.url, { moduleCache: false, tryNative: false }).import(resolve("extensions/statusbar/status-worker-host.ts"));
const origin = Date.now() - 120_000;
const usage = (cost) => ({ input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const user = (timestamp = origin) => ({ role: "user", content: "Example", timestamp });
const assistant = (id, cost, content = [], timestamp = origin + 1000) => ({ role: "assistant", responseId: id,
  provider: "example", model: "example", api: "openai-completions", content, usage: usage(cost), stopReason: "stop", timestamp });
const result = (id, name, details = {}, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name,
  content: [], details, isError, timestamp: origin + 2000 });

function file(name, messages, parentSession) {
  const path = join(dir, `${name}.jsonl`);
  const header = { type: "session", version: 3, id: name, cwd: dir, timestamp: new Date(origin).toISOString(), ...(parentSession ? { parentSession } : {}) };
  const entries = messages.map((message, i) => ({ type: "message", id: `${name}-${i}`, parentId: i ? `${name}-${i - 1}` : null,
    timestamp: new Date(message.timestamp ?? origin).toISOString(), message }));
  writeFileSync(path, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

async function start(path, { workerEntry } = {}) {
  if (workerEntry) process.env.PMLS_WORKER_ENTRY = workerEntry;
  else delete process.env.PMLS_WORKER_ENTRY;
  const sm = typeof path === "string" ? SessionManager.open(path, dir) : path;
  let historyReads = 0;
  const originalGetEntries = sm.getEntries.bind(sm);
  sm.getEntries = () => { historyReads++; return originalGetEntries(); };
  const handlers = new Map();
  const statuses = new Map();
  let footer;
  let revision = 0;
  const theme = { fg: (_tone, text) => text, bold: (text) => text };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {}, registerShortcut() {},
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    getThinkingLevel: () => "off", getActiveTools: () => [], getAllTools: () => [],
  };
  const ctx = { cwd: dir, hasUI: true, mode: "tui", sessionManager: sm,
    getContextUsage: () => undefined, modelRegistry: { isUsingOAuth: () => false },
    ui: { theme, notify() {}, setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
      setFooter(factory) {
        footer?.dispose?.();
        footer = factory?.({ requestRender() { revision++; } }, theme, {
          onBranchChange: () => () => {}, getGitBranch: () => null,
          getAvailableProviderCount: () => 1, getExtensionStatuses: () => statuses,
        });
      } },
  };
  footerExtension(pi);
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  return {
    sm, ctx, handlers, statuses,
    get historyReads() { return historyReads; },
    get revision() { return revision; },
    render: () => footer.render(2000).join("\n"),
    emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
    async add(message) {
      sm.appendMessage(message);
      await handlers.get("message_end")({ message }, ctx);
    },
    close: () => handlers.get("session_shutdown")({ reason: "quit" }, ctx),
  };
}

async function until(check, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await wait(20);
  }
  assert.fail(`Timed out: ${label}`);
}

test("session accounting loads without walking history on the UI thread", async () => {
  const path = file("resume", [user(), assistant("reply", 1.25)]);
  const host = await start(path);
  try {
    await until(() => /active .*\$1\.25/.test(host.render()), "restored cost");
    assert.equal(host.historyReads, 0, "accounting must not call SessionManager.getEntries on the UI thread");
    assert.match(host.render(), /run .*\$0\.00/);
    assert.match(host.render(), /↑100/);
  } finally { await host.close(); }
});

test("new messages update active/run totals once, and restart resets only run", async () => {
  const path = file("live", [user(), assistant("old", 1.25, [
    { type: "toolCall", id: "old-write", name: "write", arguments: { content: "a\nb" } },
  ]), result("old-write", "write")]);
  const host = await start(path);
  try {
    // Arrives before the first background answer: must not enter the resume baseline.
    const reply = assistant("new", 0.5, [
      { type: "toolCall", id: "new-write", name: "write", arguments: { content: "a\nb\nc" } },
      { type: "toolCall", id: "failed-write", name: "write", arguments: { content: "not\ncounted" } },
    ], Date.now());
    await host.add(reply);
    await host.add(result("new-write", "write"));
    await host.add(result("failed-write", "write", {}, true));
    await host.add(result("edit", "edit", { patch: "--- before\n+++ after\n@@ hunk\n-old\n+new" }));
    await host.emit("turn_end", { message: reply });
    await host.emit("turn_end", { message: reply });
    await host.emit("agent_end");
    await until(() => /active [^·]*\$1\.75/.test(host.render()), "live cost");
    // Historical write: 2 lines; live write: 3; edit: +1/-1; failed write: 0.
    assert.match(host.render(), /active [^·]*\$1\.75 \/ \+6−1/);
    assert.match(host.render(), /run [^·]*\$0\.50 \/ \+4−1/);
    assert.match(host.render(), /↑200/);
    assert.equal(host.historyReads, 0);
  } finally { await host.close(); }
  const resumed = await start(path);
  try {
    await until(() => /active [^·]*\$1\.75/.test(resumed.render()), "restart cost");
    assert.match(resumed.render(), /run [^·]*\$0\.00/);
    assert.equal(resumed.historyReads, 0);
  } finally { await resumed.close(); }
});

test("fork ancestry counts copied entries once and retains uncopied ancestor work", async () => {
  const path = file("parent", [user(), assistant("inherited", 1.25), assistant("other-parent-work", 2.5)]);
  const parent = SessionManager.open(path, dir);
  const branch = parent.createBranchedSession("parent-1");
  assert.ok(branch);
  const host = await start(branch);
  try {
    await host.add(assistant("child-work", 0.5, [], Date.now()));
    await until(() => /chain [^·]*\$4\.25/.test(host.render()), "deduplicated chain");
    assert.match(host.render(), /active [^·]*\$1\.75/);
    assert.match(host.render(), /run [^·]*\$0\.50/);
    assert.equal(host.historyReads, 0);
  } finally { await host.close(); }
});

test("worker tails new bytes, buffers partial UTF-8 records, and rebuilds rewritten files", async () => {
  const path = file("tail", [user(), assistant("old", 1.25)]);
  const worker = new StatusWorker();
  const request = { sessionFile: path, runBoundary: statSync(path).size };
  try {
    const first = await worker.readAccounting(request);
    assert.equal(first.usage.totalCost, 1.25);
    assert.equal(first.run.cost, 0);
    const idle = await worker.readAccounting(request);
    assert.ok(idle.work.bytesRead <= 128, "unchanged history must not be read again");
    const entry = Buffer.from(JSON.stringify({ type: "message", id: "tail-new", timestamp: new Date().toISOString(),
      message: assistant("new", 0.5, [{ type: "text", text: "example 🐎" }], Date.now()) }) + "\n");
    const cut = entry.indexOf(Buffer.from("🐎")) + 2;
    appendFileSync(path, entry.subarray(0, cut));
    assert.equal((await worker.readAccounting(request)).usage.totalCost, 1.25);
    appendFileSync(path, entry.subarray(cut));
    const next = await worker.readAccounting(request);
    assert.equal(next.usage.totalCost, 1.75);
    assert.equal(next.run.cost, 0.5);
    assert.ok(next.work.bytesRead <= entry.length + 128);
    const raw = readFileSync(path, "utf8").replaceAll('"total":1.25', '"total":2.25');
    writeFileSync(path, raw);
    const rewritten = await worker.readAccounting(request);
    assert.equal(rewritten.usage.totalCost, 2.75);
    assert.equal(rewritten.run.cost, 1.5);
    const reset = await worker.readAccounting({ ...request, reset: true });
    assert.equal(reset.usage.totalCost, 2.75);
  } finally { worker.stop(); }
});

test("an initially absent session discovers its ancestry when first persisted", async () => {
  const parent = file("late-parent", [user(), assistant("parent-reply", 2)]);
  const path = join(dir, "late-file.jsonl");
  const worker = new StatusWorker();
  try {
    const request = { sessionFile: path, runBoundary: 0 };
    assert.equal((await worker.readAccounting(request)).usage.totalCost, 0);
    file("late-file", [user(), assistant("child-reply", 1)], parent);
    const ready = await worker.readAccounting(request);
    assert.equal(ready.usage.totalCost, 1);
    assert.equal(ready.ancestors.hasParent, true);
    assert.equal(ready.ancestors.cost, 2);
  } finally { worker.stop(); }
});

test("in-memory sessions retain historical totals and count only new work in run", async () => {
  const sm = SessionManager.inMemory(dir);
  sm.appendMessage(user());
  sm.appendMessage(assistant("memory-old", 1.25));
  const host = await start(sm);
  try {
    await host.add(assistant("memory-new", 0.5, [], Date.now()));
    await until(() => /active [^·]*\$1\.75/.test(host.render()), "in-memory total");
    assert.match(host.render(), /run [^·]*\$0\.50/);
    const revision = host.revision;
    await host.emit("session_tree");
    await until(() => host.revision > revision, "in-memory reset answer");
    assert.match(host.render(), /active [^·]*\$1\.75/);
  } finally { await host.close(); }
});

test("worker errors reject rather than publish zero, and stop/restart isolates requests", async () => {
  const valid = file("worker-valid", [user(), assistant("ok", 1)]);
  const invalid = join(dir, "invalid.jsonl");
  writeFileSync(invalid, "not json\n");
  const worker = new StatusWorker();
  const request = { sessionFile: valid, runBoundary: statSync(valid).size };
  try {
    await assert.rejects(worker.readAccounting({ ...request, sessionFile: invalid }), /Invalid JSON/);
    assert.equal((await worker.readAccounting(request)).usage.totalCost, 1);
    const pending = worker.readAccounting(request);
    worker.stop();
    await assert.rejects(pending, /stopped/);
    assert.equal((await worker.readAccounting(request)).usage.totalCost, 1);
  } finally { worker.stop(); }
  const shortDeadline = new StatusWorker(1);
  try { await assert.rejects(shortDeadline.readAccounting(request), /timed out/); }
  finally { shortDeadline.stop(); }
});

test("large-session accounting leaves the parent event loop responsive", async () => {
  const path = file("large", [user()]);
  const fd = openSync(path, "a");
  const count = 20_000;
  try {
    for (let i = 0; i < count; i++) {
      writeSync(fd, JSON.stringify({ type: "message", id: `large-${i + 1}`, parentId: "large-0",
        timestamp: new Date(origin + 1000 + i).toISOString(),
        message: assistant(`reply-${i}`, 0.01, [{ type: "text", text: "x".repeat(1024) }], origin + 1000 + i) }) + "\n");
    }
  } finally { closeSync(fd); }
  const host = await start(path);
  const delays = [];
  let previous = performance.now();
  const pulse = setInterval(() => {
    const now = performance.now();
    delays.push(now - previous);
    previous = now;
  }, 10);
  try {
    await until(() => /active [^·]*\$200\.00/.test(host.render()), "large history total", 20_000);
    const maximum = Math.max(...delays, performance.now() - previous);
    console.log(JSON.stringify({ scenario: "large-accounting", entries: count + 1,
      bytes: statSync(path).size, heartbeatSamples: delays.length, maximumHeartbeatMs: Math.round(maximum), historyReads: host.historyReads }));
    assert.equal(host.historyReads, 0);
    assert.match(host.render(), /run [^·]*\$0\.00/);
    assert.ok(delays.length > 5);
    assert.ok(maximum < 250, `Parent event loop stalled for ${maximum}ms`);
    await host.add(assistant("after-large", 0.5, [], Date.now()));
    await until(() => /active [^·]*\$200\.50/.test(host.render()), "large-session live update");
    assert.match(host.render(), /run [^·]*\$0\.50/);
    assert.equal(host.historyReads, 0);
  } finally { clearInterval(pulse); await host.close(); }
});

test("a corrupted session file keeps the totals and recovers when repaired", async () => {
  const path = file("recover", [user(), assistant("old", 1.25)]);
  const original = readFileSync(path);
  const host = await start(path);
  try {
    await until(() => /active [^·]*\$1\.25/.test(host.render()), "initial total");
    writeFileSync(path, "invalid json\n");
    await host.emit("session_tree");
    await until(() => host.render().includes("accounting stale"), "the failure is announced");
    assert.match(host.render(), /active [^·]*\$1\.25/, "the last good totals are kept, not invented");
    assert.match(host.render(), /Invalid JSON/, "and the reason is on screen");
    writeFileSync(path, original);
    await host.emit("session_tree");
    await until(() => !host.render().includes("accounting stale"), "back to the worker");
    assert.match(host.render(), /active [^·]*\$1\.25/);
  } finally { await host.close(); }
});

test("session replacement cancels queued reads and discards the old totals", async () => {
  const old = file("switch-old", [user(), assistant("old", 1.25)]);
  const next = file("switch-new", [user(), assistant("new", 9)]);
  const host = await start(old);
  try {
    await until(() => /active [^·]*\$1\.25/.test(host.render()), "first session");
    await host.emit("agent_end");
    await host.emit("session_shutdown", { reason: "resume" });
    host.sm.setSessionFile(next);
    await host.emit("session_start", { reason: "resume" });
    assert.ok(!host.render().includes("$1.25"));
    await until(() => /active [^·]*\$9\.00/.test(host.render()), "replacement session");
    assert.match(host.render(), /run [^·]*\$0\.00/);
    assert.equal(host.historyReads, 0);
  } finally { await host.close(); }
});

test("missing ancestors mark chain costs as approximate instead of silently exact", async () => {
  const path = file("missing-parent", [user(), assistant("only-known", 1.25)], join(dir, "absent-parent.jsonl"));
  const host = await start(path);
  try {
    await until(() => host.render().includes("chain"), "partial chain");
    assert.match(host.render(), /chain [^·]*~\$1\.25/);
    assert.match(host.render(), /active [^·]*\$1\.25/);
  } finally { await host.close(); }
});

test("a worker that dies between requests is replaced without the user seeing a failure", async () => {
  const path = file("respawn", [user(), assistant("paid", 1.25)]);
  const worker = new StatusWorker();
  const request = { sessionFile: path, runBoundary: statSync(path).size };
  try {
    assert.equal((await worker.readAccounting(request)).usage.totalCost, 1.25);
    // Exactly what the idle guard, or the operating system, can do at any moment.
    worker.stop();
    assert.equal((await worker.readAccounting(request)).usage.totalCost, 1.25, "the next read just works");
  } finally { worker.stop(); }
});

test("a worker that crashes on startup reports its error, not just 'exited'", async () => {
  // The shape of the report we could not act on: the helper starts, dies immediately, and the
  // only clue was the word "exited". Its own output must reach the user.
  const broken = join(dir, "broken-worker.mjs");
  writeFileSync(broken, 'import "./definitely-not-here.mjs";\n');
  const path = file("crashing", [user(), assistant("paid", 1.25)]);
  const host = await start(path, { workerEntry: broken });
  try {
    await until(() => /accounting unavailable/.test(host.render()), "failure announced");
    const shown = host.render();
    assert.match(shown, /could not start|exited early/, "the kind of failure is named");
    assert.match(shown, /definitely-not-here|Cannot find module/, "and the worker's own error text");
  } finally { await host.close(); delete process.env.PMLS_WORKER_ENTRY; }
});

test("a worker that cannot run says exactly why, on the bar", async () => {
  const path = file("no-worker", [user(), assistant("paid", 1.25)]);
  // Reproduces a machine where the helper cannot start: a sandbox, a packaging that dropped the
  // file, an unsupported runtime. The failure must name itself rather than be papered over.
  const host = await start(path, { workerEntry: join(dir, "absent-worker.mjs") });
  try {
    await until(() => /accounting unavailable/.test(host.render()), "the failure is announced");
    assert.match(host.render(), /absent-worker\.mjs/, "and the reason is on screen, not hidden");
    assert.ok(!/\$1\.25/.test(host.render()), "no invented totals");
  } finally { await host.close(); delete process.env.PMLS_WORKER_ENTRY; }
});

test("unrelated ancestor messages with colliding short IDs are not dropped", async () => {
  const parent = file("collision-parent", [user(), assistant("parent-request", 2)]);
  const child = file("collision-child", [user(), assistant("child-request", 1, [], origin + 5000)], parent);
  const content = readFileSync(child, "utf8").replace('"id":"collision-child-1"', '"id":"collision-parent-1"');
  writeFileSync(child, content);
  const worker = new StatusWorker();
  try {
    const snapshot = await worker.readAccounting({ sessionFile: child, runBoundary: statSync(child).size });
    assert.equal(snapshot.usage.totalCost, 1);
    assert.equal(snapshot.ancestors.cost, 2);
  } finally { worker.stop(); }
});

test("the worker reads only the active session, never the surrounding transcript directory", async () => {
  const path = file("isolated", [user(), assistant("only", 1)]);
  // Neighbours in the same folder must not be opened: the removed calibration pass used to scan them all.
  for (let i = 0; i < 5; i++) file(`neighbour-${i}`, [user(), assistant(`other-${i}`, 5)]);
  const worker = new StatusWorker();
  try {
    const snapshot = await worker.readAccounting({ sessionFile: path, runBoundary: 0 });
    assert.equal(snapshot.usage.totalCost, 1);
    assert.equal(snapshot.work.filesRead, 1, "exactly one file: the session itself");
    assert.ok(snapshot.work.bytesRead <= statSync(path).size + 128);
  } finally { worker.stop(); }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
