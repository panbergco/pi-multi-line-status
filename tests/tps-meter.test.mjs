import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

// Characterises the bundled TPS meter: what it reports for known token counts and
// durations, and what it does when a stream is abandoned. The clock is controlled so
// rates are exact rather than timing-dependent.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const theme = { fg: (_tone, text) => text };
const plain = (s) => String(s ?? "");

async function meter() {
  // A fresh module per test: the meter keeps its statistics in module scope.
  const tpsMeter = await jiti.import(resolve("extensions/tps-meter.ts"), { default: true });
  const handlers = new Map();
  const statuses = new Map();
  const ctx = { ui: { theme, setStatus: (key, value) => statuses.set(key, value) } };
  tpsMeter({ on: (name, handler) => handlers.set(name, handler) });
  const real = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  return {
    ctx,
    status: () => plain(statuses.get("tps")),
    advance: (ms) => { clock += ms; },
    emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
    /** One complete assistant reply of `tokens` output tokens taking `seconds`. */
    async reply({ tokens, seconds, text = "hello", usage = true }) {
      const message = { role: "assistant", usage: usage ? { output: tokens } : undefined };
      await handlers.get("message_start")({ message }, ctx);
      clock += 500; // time to first token, which must not count against the rate
      await handlers.get("message_update")({ message, assistantMessageEvent: { type: "text_delta", delta: text } }, ctx);
      clock += seconds * 1000;
      await handlers.get("message_end")({ message }, ctx);
    },
    restore: () => { Date.now = real; },
  };
}

test("a completed reply reports the provider's tokens over the generation time", async () => {
  const m = await meter();
  try {
    await m.reply({ tokens: 100, seconds: 2 });
    // 100 tokens in 2s = 50 tps. Time-to-first-token is excluded by design.
    assert.match(m.status(), /(^|\s)50 tps/, m.status());
    assert.match(m.status(), /μ 50/);
    assert.match(m.status(), /p95 50/);
  } finally { m.restore(); }
});

test("statistics accumulate across replies: mean and 95th percentile", async () => {
  const m = await meter();
  try {
    for (const [tokens, seconds] of [[100, 2], [60, 2], [200, 2]]) await m.reply({ tokens, seconds });
    // rates: 50, 30, 100 → mean 60
    assert.match(m.status(), /μ 60/, m.status());
    // p95 of three samples is the largest
    assert.match(m.status(), /p95 100/, m.status());
    // the last rate leads the line
    assert.match(m.status(), /(^|\s)100 tps/, m.status());
  } finally { m.restore(); }
});

test("without provider usage it falls back to counting characters", async () => {
  const m = await meter();
  try {
    // 400 characters ≈ 100 tokens by the 4-chars-per-token fallback, over 2s → 50 tps
    await m.reply({ tokens: 0, seconds: 2, text: "x".repeat(400), usage: false });
    assert.match(m.status(), /(^|\s)50 tps/, m.status());
  } finally { m.restore(); }
});

test("an abandoned stream stops repainting and keeps the last completed rate", async () => {
  const m = await meter();
  try {
    await m.reply({ tokens: 100, seconds: 2 });
    const settled = m.status();
    await m.emit("message_start", { message: { role: "assistant" } });
    await m.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "partial" } });
    await m.emit("agent_end", {});
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(m.status(), settled, "an aborted reply must not overwrite the last real measurement");
  } finally { m.restore(); }
});

// The status worker is the only process this package leaves running. These checks exist because a
// previous build abandoned one on every reload, and abandoned workers were found alive a day later.
const workerExit = (act, { env = {} } = {}) => new Promise((done, fail) => {
  const worker = new Worker(resolve("extensions/statusbar/status-worker.mjs"), { env: { ...process.env, ...env } });
  const timer = setTimeout(() => { void worker.terminate(); fail(new Error("worker never exited")); }, 15_000);
  worker.on("exit", (code) => { clearTimeout(timer); done({ code }); });
  worker.on("online", () => setTimeout(() => act(worker), 200));
});

test("the worker only ends itself on positive evidence, never on a missing property", async () => {
  const { shouldWorkerExit } = await import(resolve("extensions/statusbar/status-worker.mjs"));
  const base = { port: {}, idleForMs: 0, idleLimitMs: 1000 };
  // The defect that killed a healthy worker on another machine: an unknown port state must not
  // read as "gone".
  assert.equal(shouldWorkerExit({ ...base, port: undefined }), false, "unknown is not gone");
  assert.equal(shouldWorkerExit({ ...base, port: null }), true, "an explicitly closed port ends it");
  assert.equal(shouldWorkerExit({ ...base, idleForMs: 1001 }), true, "being abandoned ends it");
});

test("the worker exits when its host lets it go", async () => {
  assert.deepEqual(await workerExit((worker) => void worker.terminate()), { code: 1 });
});

test("an abandoned worker exits by itself instead of lingering", async () => {
  // Same shape as a reload that forgets to stop the old worker: channel open, nothing ever asked.
  assert.deepEqual(await workerExit(() => {}, { env: { PMLS_WORKER_IDLE_MS: "600" } }), { code: 0 });
});

test("a worker still being used is not killed by the idle guard", async () => {
  const worker = new Worker(resolve("extensions/statusbar/status-worker.mjs"),
    { env: { ...process.env, PMLS_WORKER_IDLE_MS: "600" } });
  try {
    let exited = false;
    worker.on("exit", () => { exited = true; });
    for (let i = 0; i < 6; i++) {
      worker.postMessage({ id: i + 1, sessionFile: null, runBoundary: 0, entries: [] });
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(exited, false, "a worker answering requests must stay alive");
  } finally { void worker.terminate(); }
});

test("a reply too short to measure is discarded rather than reported as a spike", async () => {
  const m = await meter();
  try {
    await m.reply({ tokens: 100, seconds: 2 });
    const settled = m.status();
    await m.reply({ tokens: 5, seconds: 0.05 });
    assert.equal(m.status(), settled, "sub-100ms replies carry no usable rate");
  } finally { m.restore(); }
});
