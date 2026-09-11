/**
 * Session accounting runs here, off the thread that draws the terminal: reading a long transcript
 * must never block a keystroke. The reader keeps a cursor and consumes only newly appended entries.
 * Only totals cross back to the footer.
 *
 * THIS IS A THREAD, NOT A CHILD PROCESS, AND THAT IS THE POINT. Forking asks the operating system
 * to launch "whatever is currently executing" with this file as an argument. Under a bundled
 * single-file build, that is the host application itself: it starts a second copy of the app with
 * a file path where a prompt should be, which then dies — leaving stray sessions behind and a
 * status bar reporting a worker that "exited". A thread cannot relaunch anything; it also starts
 * in milliseconds and costs a fraction of the memory.
 */
import { parentPort } from "node:worker_threads";
import { AccountingReader } from "./accounting.mjs";

let accounting = new AccountingReader();

const IDLE_EXIT_MS = Number(process.env.PMLS_WORKER_IDLE_MS || 30 * 60_000);
let lastAskedAt = Date.now();

/**
 * Every condition must be POSITIVELY true before this worker ends itself. A check like
 * `!port` treats "unknown" as "gone" and kills a healthy worker on the first tick — an
 * outage indistinguishable from a broken install. Absence of evidence is not disconnection.
 * Exported so the rule can be tested directly instead of by faking a runtime.
 */
export function shouldWorkerExit({ port, idleForMs, idleLimitMs }) {
  if (port === null) return true;
  return idleForMs > idleLimitMs;
}

const guard = setInterval(() => {
  if (shouldWorkerExit({ port: parentPort, idleForMs: Date.now() - lastAskedAt, idleLimitMs: IDLE_EXIT_MS })) {
    process.exit(0);
  }
}, Math.min(30_000, Math.max(250, IDLE_EXIT_MS / 4)));
guard.unref?.();

// The host going away closes this port; nothing is left running behind it.
parentPort?.on("close", () => process.exit(0));

parentPort?.on("message", (raw) => {
  const ask = raw ?? {};
  if (typeof ask.id !== "number") return;
  lastAskedAt = Date.now();
  const reply = (message) => {
    // Reporting must not become a second, fatal failure if the port has already gone.
    try { parentPort?.postMessage(message); } catch { /* channel gone */ }
  };
  try {
    if (ask.sessionFile !== null && typeof ask.sessionFile !== "string") throw new Error("Invalid session file");
    if (!Number.isFinite(ask.runBoundary) || ask.runBoundary < 0) throw new Error("Invalid accounting boundary");
    reply({ id: ask.id, accounting: accounting.read(ask), why: null });
  } catch (e) {
    accounting = new AccountingReader();
    reply({ id: ask.id, why: String(e?.message ?? e).slice(0, 200) });
  }
});
