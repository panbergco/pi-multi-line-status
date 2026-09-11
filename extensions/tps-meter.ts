/**
 * TPS Meter v3 — Tokens Per Second with Sparkline Trend
 *
 * Footer display:
 *   Streaming:  ⠹ ▕███████▋···▏ 47 tps   (smooth, animated, auto-scaled gauge)
 *   Complete:   ▁▄▇▅▂▁▇█▅▃▆▇ 42 tps · μ 39 · p95 61
 *
 * Features:
 *   - Live sub-cell gauge (1/8-cell resolution) that fills as you stream
 *   - Min-max normalized sparkline (▁▂▃▄▅▆▇█) so the trend's shape is readable
 *   - Color-coded by speed (green fast / yellow mid / red slow)
 *   - Animated spinner during streaming
 *   - Mean and 95th percentile over the last 500 completed replies
 *
 * Accuracy:
 *   - Uses the provider's real output token count (message.usage.output);
 *     bitwise char/4 estimate is only a fallback for providers without usage
 *   - Rate measured from first token (excludes time-to-first-token latency)
 *
 * Optimizations:
 *   - Fixed ring buffers (no allocations in the streaming repaint path)
 *   - Memoized sparkline (rebuilt once per message, not every tick)
 *   - Single shared 200ms timer, torn down on message_end and agent_end
 *   - Insertion sort for p95 (cold path, ≤500 elements)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Config ---
const STREAM_INTERVAL_MS = 200;
const SPARK_LEN = 12;
const ALLTIME_CAP = 500;
const FAST = 50;
const MED = 20;

// --- Sparkline chars (8 vertical levels) ---
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

// --- Horizontal partial blocks for the live gauge (1/8th-cell resolution) ---
// index = eighths of a cell that are filled (0 = empty .. 7 = ▉); 8 = full "█"
const HBLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const GAUGE_LEN = 11; // gauge width in cells
const GAUGE_FLOOR = 40; // tps that reads as a "full-ish" bar before we have history

// Graph cell must be the same visible width in both states so the bar never
// reflows when swapping sparkline ↔ live gauge. Streaming cell = spinner(1) +
// space(1) + gauge(brackets 2 + GAUGE_LEN) = GAUGE_LEN + 4 visible cells.
const GRAPH_WIDTH = GAUGE_LEN + 4;

// Visible-width-aware right-pad for strings that contain ANSI color codes.
function visibleLen(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}
function padToWidth(s: string, width: number, theme: any): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? s + theme.fg("dim", TRACK.repeat(pad)) : s;
}
const TRACK = "·"; // faint empty-track glyph (less janky than blank space)

// --- State ---
let streamStartMs = 0;
let firstTokenMs = 0; // when the first delta arrived (excludes TTFT from rate)
let streamChars = 0;
let streamTokens = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let streaming = false;
// Last completed generation rate — kept so the TTFT gap at the start of a new
// message doesn't collapse the display to 0, and so idle never goes blank.
let lastTps = 0;

// All-time stats (circular buffer)
const atBuf = new Float64Array(ALLTIME_CAP);
let atLen = 0;
let atHead = 0;
let atSum = 0;

// Sparkline history (ring buffer of TPS values, last N messages)
const sparkBuf = new Float64Array(SPARK_LEN);
let sparkLen = 0;
let sparkHead = 0;
let sparkMax = 1; // track max for normalization
let sparkCache = ""; // memoized rendered sparkline (only changes once per message)
let sparkDirty = true;
let sparkTheme: unknown = null; // invalidate cache if the theme changes mid-session

// --- Helpers ---

function now(): number {
  return Date.now();
}

function tokEst(ch: number): number {
  return (ch >>> 2) + ((ch & 3) > 0 ? 1 : 0);
}

function atPush(tps: number): void {
  atSum += tps;
  if (atLen >= ALLTIME_CAP) atSum -= atBuf[atHead];
  atBuf[atHead] = tps;
  atHead = (atHead + 1) % ALLTIME_CAP;
  if (atLen < ALLTIME_CAP) atLen++;
}

function sparkPush(tps: number): void {
  sparkBuf[sparkHead] = tps;
  sparkHead = (sparkHead + 1) % SPARK_LEN;
  if (sparkLen < SPARK_LEN) sparkLen++;
  if (tps > sparkMax) sparkMax = tps;
  // Decay max slowly so sparkline adapts
  if (sparkMax > 10) sparkMax *= 0.99;
  sparkDirty = true;
}

function atMean(): number {
  return atLen === 0 ? 0 : atSum / atLen;
}

function atP95(): number {
  if (atLen === 0) return 0;
  const tmp = new Float64Array(atLen);
  const oldest = atLen < ALLTIME_CAP ? 0 : atHead;
  for (let i = 0; i < atLen; i++) tmp[i] = atBuf[(oldest + i) % ALLTIME_CAP];
  // Insertion sort
  for (let i = 1; i < tmp.length; i++) {
    const v = tmp[i];
    let j = i - 1;
    while (j >= 0 && tmp[j] > v) {
      tmp[j + 1] = tmp[j];
      j--;
    }
    tmp[j + 1] = v;
  }
  return tmp[Math.ceil(tmp.length * 0.95) - 1] || 0;
}

function fmt(v: number): string {
  if (v < 10) return v.toFixed(1);
  if (v < 100) return v.toFixed(0);
  return `${Math.round(v)}`;
}

// --- Sparkline rendering ---

function sparkline(theme: any): string {
  // Sparkline data only changes once per message (sparkPush), so memoize the
  // rendered string instead of re-allocating + recoloring on every 200ms tick.
  // Invalidate if the active theme changed (user switched themes mid-session).
  if (theme !== sparkTheme) {
    sparkDirty = true;
    sparkTheme = theme;
  }
  if (!sparkDirty) return sparkCache;

  if (sparkLen === 0) {
    sparkCache = theme.fg("dim", "▁".repeat(SPARK_LEN));
    sparkDirty = false;
    return sparkCache;
  }

  // Read ring buffer in order (oldest first)
  const vals = new Float64Array(SPARK_LEN);
  const oldest = sparkLen < SPARK_LEN ? 0 : sparkHead;
  for (let i = 0; i < sparkLen; i++) {
    vals[i] = sparkBuf[(oldest + i) % SPARK_LEN];
  }

  // Min-max normalize over the window so the trend's *shape* is visible.
  // (Normalizing by max alone squashes 40/42/45 into a flat top — the old jank.)
  let mn = Infinity;
  let mx = 0;
  for (let i = 0; i < sparkLen; i++) {
    const v = vals[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = mx - mn;

  // Pad the left so a partial window is right-aligned (newest at the right edge).
  const pad = SPARK_LEN - sparkLen;
  let result = pad > 0 ? theme.fg("dim", TRACK.repeat(pad)) : "";

  for (let i = 0; i < sparkLen; i++) {
    const v = vals[i];
    // Flat series -> mid-height bar; otherwise spread across the full 0..7 range.
    const norm =
      range < 1e-6
        ? mx > 0
          ? 4
          : 0
        : Math.min(7, Math.max(0, Math.round(((v - mn) / range) * 7)));
    const ch = BLOCKS[norm];

    // Color each bar by absolute speed (green fast / yellow mid / red slow).
    let colored: string;
    if (v >= FAST) colored = theme.fg("success", ch);
    else if (v >= MED) colored = theme.fg("warning", ch);
    else colored = theme.fg("error", ch);

    result += colored;
  }
  sparkCache = result;
  sparkDirty = false;
  return result;
}

// --- Live gauge (smooth sub-cell horizontal bar) ---

function gauge(tps: number, theme: any): string {
  // Auto-scale to the session peak with a sane floor, so the bar is stable
  // (no wild rescaling) yet still meaningful across slow and fast models.
  const scale = Math.max(sparkMax, GAUGE_FLOOR);
  let frac = scale > 0 ? tps / scale : 0;
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  const eighths = Math.round(frac * GAUGE_LEN * 8);
  const full = (eighths / 8) | 0;
  const rem = eighths % 8;

  let fill = "█".repeat(full);
  let used = full;
  if (full < GAUGE_LEN && rem > 0) {
    fill += HBLOCKS[rem];
    used++;
  }
  const track = TRACK.repeat(GAUGE_LEN - used);

  return (
    theme.fg("dim", "▕") +
    speedColor(tps, fill, theme) +
    theme.fg("dim", track + "▏")
  );
}

// --- Spinner ---

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinI = 0;
function spin(): string {
  const s = SPIN[spinI];
  spinI = (spinI + 1) % SPIN.length;
  return s;
}

function speedColor(tps: number, text: string, theme: any): string {
  if (tps >= FAST) return theme.fg("success", text);
  if (tps >= MED) return theme.fg("warning", text);
  return theme.fg("error", text);
}

// --- Rendering ---

// Current live generation rate (0 before the first token arrives).
function liveTps(): number {
  const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
  const elapsed = (now() - ref) / 1000;
  return elapsed > 0.3 ? streamTokens / elapsed : 0;
}

/**
 * Unified fixed-width render — the ONLY render path.
 *
 * Layout (constant width in every state):
 *   [GRAPH: GAUGE_LEN cells] [tps] · μ [x] · p95 [x]
 *
 * GRAPH swaps by state — live gauge while streaming, sparkline when idle —
 * but the trailing stats are always present and always the last computed
 * values, so nothing ever disappears or changes size between states. The
 * spinner/gauge animation lives entirely inside the fixed GRAPH cell, so the
 * rest of the bar never reflows.
 */
function render(theme: any): string {
  const sep = theme.fg("dim", "·");
  const label = theme.fg("dim", "tps");

  // tps number: live rate while streaming, but hold the last completed rate
  // through the TTFT gap and when idle so it never reads 0 or blanks out.
  const rate = streaming ? liveTps() || lastTps : lastTps;
  const num = rate > 0 ? speedColor(rate, fmt(rate), theme) : theme.fg("dim", "—");

  // Stats: always the last computed mean/p95. Placeholder dashes until the
  // first message completes; never cleared after that.
  const mu = atMean();
  const p95 = atP95();
  const m = `${theme.fg("dim", "μ")} ${mu > 0 ? speedColor(mu, fmt(mu), theme) : theme.fg("dim", "—")}`;
  const p = `${theme.fg("dim", "p95")} ${p95 > 0 ? speedColor(p95, fmt(p95), theme) : theme.fg("dim", "—")}`;

  // GRAPH cell: spinner+gauge while streaming, sparkline when idle. Both are
  // padded to GRAPH_WIDTH visible cells so swapping states never reflows the
  // rest of the bar.
  const graph = streaming
    ? `${theme.fg("accent", spin())} ${gauge(liveTps(), theme)}`
    : padToWidth(sparkline(theme), GRAPH_WIDTH, theme);

  return `${graph} ${num} ${label} ${sep} ${m} ${sep} ${p}`;
}

// --- Single shared timer ---

function startTick(ctx: any, theme: any): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!streaming) {
      stopTick();
      return;
    }
    ctx.ui.setStatus("tps", render(theme));
  }, STREAM_INTERVAL_MS);
}

function stopTick(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// ============================
// Extension
// ============================

export default function tpsMeter(pi: ExtensionAPI): void {

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    streamStartMs = now();
    firstTokenMs = 0;
    streamChars = 0;
    streamTokens = 0;
    streaming = true;
    spinI = 0;
    startTick(ctx, ctx.ui.theme);
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    if (!event.assistantMessageEvent) return;
    const evt = event.assistantMessageEvent;
    if (evt.type === "text_delta" || evt.type === "thinking_delta") {
      const d = evt.delta as string;
      if (!d) return;
      if (firstTokenMs === 0) firstTokenMs = now();
      streamChars += d.length;
      streamTokens = tokEst(streamChars);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    streaming = false;
    stopTick();

    // Prefer the provider's real output token count; fall back to the char
    // estimate only when usage is unavailable (e.g. some local providers).
    const realOut = event.message?.usage?.output;
    const tokens =
      typeof realOut === "number" && realOut > 0 ? realOut : streamTokens;

    // Rate is generation-only: from first token to end, excluding TTFT.
    const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
    const elapsed = (now() - ref) / 1000;
    if (elapsed < 0.1 || tokens === 0) return;

    const tps = tokens / elapsed;
    lastTps = tps;

    // Record the completed rate
    atPush(tps);
    sparkPush(tps);

    ctx.ui.setStatus("tps", render(ctx.ui.theme));
  });

  // Safety net: if a stream is aborted (Esc/Ctrl-C) or errors, message_end may
  // not fire for that message — agent_end always does. Without this the 200ms
  // timer would keep repainting a stale live number indefinitely.
  pi.on("agent_end", async () => {
    streaming = false;
    stopTick();
  });

  pi.on("session_start", async (_event, ctx) => {
    // Reset only the live-stream transient state. Stats buffers (win/at/spark)
    // and lastTps are NOT wiped — they persist so the bar shows the last known
    // trend instead of disappearing. A brand-new process starts them at zero
    // and the placeholders (—) render until the first message completes.
    streaming = false;
    stopTick();
    streamStartMs = 0;
    firstTokenMs = 0;
    streamChars = 0;
    streamTokens = 0;
    spinI = 0;
    ctx.ui.setStatus("tps", render(ctx.ui.theme));
  });
}
