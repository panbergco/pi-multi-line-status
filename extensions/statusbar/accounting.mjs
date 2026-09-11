// Loaded by the child process, never by the footer's render path.
import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export function emptyUsage() {
  return { totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalCost: 0,
    historicalTokenSpeed: null, locAdded: 0, locRemoved: 0, firstEntryMs: null };
}

const totals = ["totalInput", "totalOutput", "totalCacheRead", "totalCacheWrite", "totalCost", "locAdded", "locRemoved"];
const finite = (n) => typeof n === "number" && Number.isFinite(n) ? n : 0;
const timestamp = (raw) => {
  const n = typeof raw === "number" ? (raw < 100_000_000_000 ? raw * 1000 : raw) : Date.parse(raw);
  return Number.isFinite(n) ? n : null;
};

function state() {
  return { usage: emptyUsage(), pendingWrites: new Map(), keys: new Set(), userTimes: [], otherTimes: [],
    parent: null, firstMs: null, offset: 0, lineOffset: 0, tail: "", decoder: new StringDecoder("utf8"),
    identity: null, signature: null, mtimeMs: null, baseline: emptyUsage(), truncated: false };
}

function countLines(text) {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

function speedFrom(times, end, tokens) {
  for (let i = times.length - 1; i >= 0; i--) {
    const seconds = (end - times[i]) / 1000;
    const speed = tokens / seconds;
    if (seconds > 0 && speed > 0 && speed <= 1000) return speed;
  }
  return null;
}

function addEntry(s, entry, excluded) {
  const entryMs = timestamp(entry.timestamp);
  if (entryMs !== null && (s.firstMs === null || entryMs < s.firstMs)) s.firstMs = entryMs;
  if (entry.type === "session") {
    s.parent = typeof entry.parentSession === "string" ? entry.parentSession : null;
    return;
  }
  if (entry.type !== "message" || !entry.message) return;
  const message = entry.message;
  const ms = timestamp(message.timestamp) ?? entryMs;
  if (s.usage.firstEntryMs === null) s.usage.firstEntryMs = ms;
  const delta = emptyUsage();
  if (message.role === "assistant") {
    const usage = message.usage;
    delta.totalInput = finite(usage?.input);
    delta.totalOutput = finite(usage?.output);
    delta.totalCacheRead = finite(usage?.cacheRead);
    delta.totalCacheWrite = finite(usage?.cacheWrite);
    delta.totalCost = finite(usage?.cost?.total);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "toolCall" && block.name === "write" && typeof block.id === "string"
        && typeof block.arguments?.content === "string") {
        s.pendingWrites.set(block.id, countLines(block.arguments.content));
      }
    }
    if (ms !== null && delta.totalOutput > 0) {
      const speed = speedFrom(s.userTimes, ms, delta.totalOutput);
      if (speed !== null) s.usage.historicalTokenSpeed = speed;
      else if (s.usage.historicalTokenSpeed === null) {
        s.usage.historicalTokenSpeed = speedFrom(s.otherTimes, ms, delta.totalOutput);
      }
    }
  } else {
    if (ms !== null) (message.role === "user" ? s.userTimes : s.otherTimes).push(ms);
    if (message.role === "toolResult") {
      if (!message.isError) {
        if (message.toolName === "edit" && typeof message.details?.patch === "string") {
          for (const line of message.details.patch.split("\n")) {
            if (line.startsWith("+++") || line.startsWith("---")) continue;
            if (line.startsWith("+")) delta.locAdded++;
            else if (line.startsWith("-")) delta.locRemoved++;
          }
        } else if (message.toolName === "write") {
          delta.locAdded = s.pendingWrites.get(message.toolCallId) ?? 0;
        }
      }
      s.pendingWrites.delete(message.toolCallId);
    }
  }
  // Forks preserve entry IDs and timestamps. Short IDs alone can collide across files.
  if (typeof entry.id === "string") {
    const key = `${entry.id}:${entry.timestamp}:${message.role}:${message.responseId ?? message.toolCallId ?? ""}`;
    if (s.keys.has(key)) return;
    s.keys.add(key);
    if (excluded?.has(key)) return;
  }
  for (const field of totals) s.usage[field] += delta[field];
}

/** Incrementally read a newline-terminated JSONL prefix, including split UTF-8 characters. */
function scan(path, s, boundary, work, excluded, limit = Infinity) {
  let fd;
  try { fd = openSync(path, "r"); } catch (error) {
    if (error.code === "ENOENT" && s.offset === 0) return s;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("Session is not a regular file");
    work.filesRead++;
    const identity = `${info.dev}:${info.ino}`;
    let rewritten = s.identity !== null && (s.identity !== identity || info.size < s.offset
      || (info.size === s.offset && info.mtimeMs !== s.mtimeMs));
    if (!rewritten && s.signature?.length) {
      const check = Buffer.alloc(s.signature.length);
      work.bytesRead += readSync(fd, check, 0, check.length, s.offset - check.length);
      rewritten = !check.equals(s.signature);
    }
    if (rewritten) s = state();
    s.identity = identity;
    s.mtimeMs = info.mtimeMs;
    const end = Math.min(info.size, limit);
    s.truncated = info.size > limit;
    const buffer = Buffer.alloc(64 * 1024);
    while (s.offset < end) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, end - s.offset), s.offset);
      if (bytes === 0) throw new Error("Session changed while being read");
      work.bytesRead += bytes;
      s.offset += bytes;
      s.tail += s.decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      let newline;
      while ((newline = s.tail.indexOf("\n", start)) !== -1) {
        const line = s.tail.slice(start, newline);
        s.lineOffset += Buffer.byteLength(line) + 1;
        start = newline + 1;
        if (line.trim()) {
          let entry;
          try { entry = JSON.parse(line); } catch { throw new Error("Invalid JSON in session history"); }
          if (!entry || typeof entry !== "object") throw new Error("Invalid session entry");
          addEntry(s, entry, excluded);
        }
        if (s.lineOffset <= boundary) s.baseline = { ...s.usage };
      }
      s.tail = s.tail.slice(start);
    }
    s.signature = Buffer.alloc(Math.min(64, s.offset));
    if (s.signature.length) work.bytesRead += readSync(fd, s.signature, 0, s.signature.length, s.offset - s.signature.length);
    return s;
  } finally { closeSync(fd); }
}

export class AccountingReader {
  active = state();
  file = undefined;
  baseline = null;
  ancestors = null;

  read(request) {
    const work = { bytesRead: 0, filesRead: 0 };
    const file = request.sessionFile;
    if (file !== this.file || request.reset) {
      this.active = state();
      this.ancestors = null;
      if (file !== this.file) this.baseline = null;
      this.file = file;
    }
    const previous = this.active;
    const previousParent = this.active.parent;
    if (file !== null) {
      this.active = scan(file, this.active, request.runBoundary, work);
      if (this.active !== previous || this.active.parent !== previousParent) this.ancestors = null;
    } else {
      this.active.parent = request.parentSession ?? null;
      for (const entry of request.entries ?? []) {
        addEntry(this.active, entry);
        this.active.offset++;
        if (this.active.offset <= request.runBoundary) this.active.baseline = { ...this.active.usage };
      }
    }
    this.baseline ??= { ...this.active.baseline };
    if (this.ancestors === null) this.ancestors = this.readAncestors(file, work);
    return {
      usage: { ...this.active.usage }, ancestors: this.ancestors,
      run: {
        cost: Math.max(0, this.active.usage.totalCost - this.baseline.totalCost),
        locAdded: Math.max(0, this.active.usage.locAdded - this.baseline.locAdded),
        locRemoved: Math.max(0, this.active.usage.locRemoved - this.baseline.locRemoved),
      }, work,
    };
  }

  readAncestors(file, work) {
    const result = { hasParent: Boolean(this.active.parent), ageFloorMs: null, cost: 0, locAdded: 0, locRemoved: 0, approx: false };
    let parent = this.active.parent;
    let base = file ? dirname(file) : process.cwd();
    const paths = new Set(file ? [resolve(file)] : []);
    // ponytail: entry IDs use memory proportional to session size; a compact ID index if needed.
    const seen = new Set(this.active.keys);
    for (let hop = 0; parent && hop < 8; hop++) {
      const path = resolve(base, parent);
      if (paths.has(path)) break;
      paths.add(path);
      let ancestor;
      try { ancestor = scan(path, state(), 0, work, seen, 8 * 1024 * 1024); } catch { break; }
      if (ancestor.identity === null) break;
      result.cost += ancestor.usage.totalCost;
      result.locAdded += ancestor.usage.locAdded;
      result.locRemoved += ancestor.usage.locRemoved;
      result.approx ||= ancestor.truncated || ancestor.tail.length > 0;
      if (ancestor.firstMs !== null && (result.ageFloorMs === null || ancestor.firstMs < result.ageFloorMs)) result.ageFloorMs = ancestor.firstMs;
      for (const key of ancestor.keys) seen.add(key);
      parent = ancestor.parent;
      base = dirname(path);
    }
    if (parent) result.approx = true;
    return result;
  }
}
