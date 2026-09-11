import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface UsageSnapshot {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  historicalTokenSpeed: number | null;
  locAdded: number;
  locRemoved: number;
  firstEntryMs: number | null;
}

export interface AccountingSnapshot {
  usage: UsageSnapshot;
  run: { cost: number; locAdded: number; locRemoved: number };
  ancestors: { hasParent: boolean; ageFloorMs: number | null; cost: number; locAdded: number; locRemoved: number; approx: boolean };
  work: { filesRead: number; bytesRead: number };
}

export interface AccountingRequest {
  sessionFile: string | null;
  runBoundary: number;
  entries?: unknown[];
  parentSession?: string;
  reset?: boolean;
}

interface Answer {
  id: number;
  accounting?: AccountingSnapshot;
  why: string | null;
}

/** Did the child process itself go away, as opposed to refusing the work? */
function isWorkerDeath(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  return /exited early|lost its channel|could not start|timed out/.test(message);
}

/** Owns the thread that reads session history; only small totals come back to the drawing thread. */
export class StatusWorker {
  private child: Worker | null = null;
  private asked = 0;
  private pending = new Map<number, { resolve: (answer: Answer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Kept for diagnostics: which runtime the worker thread started under. */
  lastExecPath: string | null = null;
  /** Bumped by stop(), so a retry cannot outlive the session it belonged to. */
  private generation = 0;
  private readonly deadlineMs: number;

  constructor(deadlineMs = 60_000) {
    this.deadlineMs = deadlineMs;
  }

  async readAccounting(request: AccountingRequest): Promise<AccountingSnapshot> {
    const payload = request as unknown as Record<string, unknown>;
    const generation = this.generation;
    let answer: Answer;
    try {
      answer = await this.request(payload);
    } catch (error) {
      // A child can die for reasons that say nothing about the next one: the idle guard fired as
      // the request left, the system reclaimed it, a transient spawn failure. One quiet retry with
      // a fresh process turns those into nothing; a real fault still surfaces on the second try.
      // An explicit stop() is not such a reason — the session is going away, and resurrecting the
      // worker would publish totals for a session that no longer exists.
      if (!isWorkerDeath(error) || this.generation !== generation) throw error;
      answer = await this.request({ ...payload, reset: true });
    }
    if (!answer.accounting) throw new Error("Status worker returned no accounting snapshot");
    return answer.accounting;
  }

  /** Session replacement clears outstanding requests and the child together. */
  stop(): void {
    this.generation += 1;
    this.fail(new Error("Status worker stopped"));
  }

  private fail(error: Error): void {
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    void child?.terminate().catch(() => {});
  }

  private request(payload: Record<string, unknown>): Promise<Answer> {
    return new Promise((resolve, reject) => {
      try {
        const child = this.ensure();
        const id = ++this.asked;
        const timer = setTimeout(() => {
          if (this.child === child) this.fail(new Error("Status worker response timed out"));
        }, this.deadlineMs);
        timer.unref?.();
        this.pending.set(id, { resolve, reject, timer });
        child.postMessage({ ...payload, id });
      } catch (error) {
        this.fail(error as Error);
        reject(error);
      }
    });
  }

  private ensure(): Worker {
    if (this.child) return this.child;
    const here = dirname(fileURLToPath(import.meta.url));
    // An explicit override is authoritative: if it is set and wrong, that is the answer, not a
    // silent fall-through to a different file. Packagers use it; the tests use it to simulate a
    // machine where the worker cannot run at all.
    const override = process.env.PMLS_WORKER_ENTRY?.trim();
    if (override) {
      if (!existsSync(override)) throw new Error(`Status worker not found at PMLS_WORKER_ENTRY: ${override}`);
      return this.spawn(override);
    }
    const entry = [join(here, "status-worker.mjs"), join(here, "..", "status-worker.mjs")].find((path) => existsSync(path));
    if (!entry) throw new Error(`Status worker file not found next to ${here}`);
    return this.spawn(entry);
  }

  private spawn(entry: string): Worker {
    // A thread, not a process: nothing can be relaunched, nothing is left behind, and start-up is
    // milliseconds instead of tens of megabytes. Its errors arrive as events rather than as text
    // on a discarded stderr, so a failure can always name itself.
    const worker = new Worker(entry, { stdout: true, stderr: true });
    this.child = worker;
    this.lastExecPath = `${process.execPath} (worker thread)`;
    worker.unref();
    let output = "";
    worker.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-600); });
    const died = (how: string, extra?: string) => {
      const lines = [extra ?? "", output].join("\n").split("\n").map((line) => line.trim()).filter(Boolean);
      const detail = (lines.filter((line) => /error|ERR_[A-Z_]+|cannot|not found/i.test(line))[0] ?? lines[0] ?? "").slice(0, 200);
      return new Error(`Status worker ${how}${detail ? `: ${detail}` : ""}`);
    };
    worker.on("message", (raw: unknown) => {
      if (this.child !== worker) return;
      const answer = raw as Answer;
      if (typeof answer?.id !== "number") return;
      const pending = this.pending.get(answer.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(answer.id);
      if (answer.why) pending.reject(new Error(answer.why));
      else pending.resolve(answer);
    });
    worker.on("error", (error) => { if (this.child === worker) this.fail(died("could not start", error.message)); });
    worker.on("exit", (code) => { if (this.child === worker) this.fail(died(`exited early (code ${code})`)); });
    return worker;
  }
}
