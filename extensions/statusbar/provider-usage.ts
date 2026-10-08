import { readFileSync, statSync } from "node:fs";
/** A provider id; with pi-rotate, any account it measures (`anthropic-ps`, `openai-codex-pb`, …). */
export type ProviderUsageSource = string;

export type ProviderUsageHeaders = Readonly<Record<string, string | undefined>>;

export type ProviderUsageWindow = {
  /** Compact truthful label derived from provider metadata (for example 5h or weekly). */
  label: string;
  usedPercent: number;
  /** Provider-reported duration, when available. */
  windowMinutes?: number;
  /** Absolute reset time, normalized to Unix milliseconds. */
  resetAt?: number;
  /** Relative reset time when a provider supplies no usable absolute time. */
  resetAfterSeconds?: number;
};

export type ProviderUsageSnapshot = {
  provider: ProviderUsageSource;
  primary: ProviderUsageWindow;
  secondary: ProviderUsageWindow;
  plan?: string;
  /** When these figures were measured, Unix ms. */
  fetchedAt?: number;
};

function parseFiniteNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parsePercent(raw: string | undefined, scale: number): number | undefined {
  const value = parseFiniteNumber(raw);
  if (value === undefined || value < 0 || value > scale) return undefined;
  return (value * 100) / scale;
}

function parseNonNegativeNumber(raw: string | undefined): number | undefined {
  const value = parseFiniteNumber(raw);
  return value !== undefined && value >= 0 ? value : undefined;
}

function parseResetAt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric < 0) return undefined;
    // Provider reset epochs are normally seconds, but tolerate milliseconds.
    return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalText(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function parseWindowMinutes(raw: string | undefined): number | undefined {
  const value = parseFiniteNumber(raw);
  return value !== undefined && value > 0 ? value : undefined;
}

function formatCodexWindowLabel(windowMinutes: number | undefined, fallback: "primary" | "secondary"): string {
  if (windowMinutes === undefined) return fallback;
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 1_440) return "daily";
  if (windowMinutes === 10_080) return "weekly";
  if (windowMinutes === 43_200) return "monthly";
  if (windowMinutes === 525_600) return "annual";
  if (Number.isInteger(windowMinutes / 1_440)) return `${windowMinutes / 1_440}d`;
  if (Number.isInteger(windowMinutes / 60)) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/** Parse Codex subscription usage from normalized response headers. */
export function parseCodexProviderUsage(headers: ProviderUsageHeaders): ProviderUsageSnapshot | undefined {
  const primaryPercent = parsePercent(headers["x-codex-primary-used-percent"], 100);
  const secondaryPercent = parsePercent(headers["x-codex-secondary-used-percent"], 100);
  if (primaryPercent === undefined || secondaryPercent === undefined) return undefined;

  const primaryWindowMinutes = parseWindowMinutes(headers["x-codex-primary-window-minutes"]);
  const secondaryWindowMinutes = parseWindowMinutes(headers["x-codex-secondary-window-minutes"]);
  const primaryResetAt = parseResetAt(headers["x-codex-primary-reset-at"]);
  const primaryResetAfterSeconds = parseNonNegativeNumber(headers["x-codex-primary-reset-after-seconds"]);
  const secondaryResetAt = parseResetAt(headers["x-codex-secondary-reset-at"]);
  const secondaryResetAfterSeconds = parseNonNegativeNumber(headers["x-codex-secondary-reset-after-seconds"]);
  const plan = optionalText(headers["x-codex-plan-type"]);

  return {
    provider: "openai-codex",
    primary: {
      label: formatCodexWindowLabel(primaryWindowMinutes, "primary"),
      usedPercent: primaryPercent,
      ...(primaryWindowMinutes !== undefined ? { windowMinutes: primaryWindowMinutes } : {}),
      ...(primaryResetAt !== undefined ? { resetAt: primaryResetAt } : {}),
      ...(primaryResetAfterSeconds !== undefined ? { resetAfterSeconds: primaryResetAfterSeconds } : {}),
    },
    secondary: {
      label: formatCodexWindowLabel(secondaryWindowMinutes, "secondary"),
      usedPercent: secondaryPercent,
      ...(secondaryWindowMinutes !== undefined ? { windowMinutes: secondaryWindowMinutes } : {}),
      ...(secondaryResetAt !== undefined ? { resetAt: secondaryResetAt } : {}),
      ...(secondaryResetAfterSeconds !== undefined ? { resetAfterSeconds: secondaryResetAfterSeconds } : {}),
    },
    ...(plan !== undefined ? { plan } : {}),
  };
}

/** Parse Anthropic subscription usage from normalized response headers. */
export function parseAnthropicProviderUsage(headers: ProviderUsageHeaders): ProviderUsageSnapshot | undefined {
  const fiveHourPercent = parsePercent(headers["anthropic-ratelimit-unified-5h-utilization"], 1);
  const sevenDayPercent = parsePercent(headers["anthropic-ratelimit-unified-7d-utilization"], 1);
  if (fiveHourPercent === undefined || sevenDayPercent === undefined) return undefined;

  const fiveHourResetAt = parseResetAt(headers["anthropic-ratelimit-unified-5h-reset"]);
  const sevenDayResetAt = parseResetAt(headers["anthropic-ratelimit-unified-7d-reset"]);

  return {
    provider: "anthropic",
    primary: {
      label: "5h",
      usedPercent: fiveHourPercent,
      windowMinutes: 300,
      ...(fiveHourResetAt !== undefined ? { resetAt: fiveHourResetAt } : {}),
    },
    secondary: {
      label: "7d",
      usedPercent: sevenDayPercent,
      windowMinutes: 10_080,
      ...(sevenDayResetAt !== undefined ? { resetAt: sevenDayResetAt } : {}),
    },
  };
}

function formatPercent(value: number): string {
  return String(Math.round(value));
}

/**
 * pi-rotate's latest reading for one account, from the file it keeps for every session.
 *
 * Response headers only describe the account that answered the last reply, and only
 * under the provider names this file knows; pi-rotate measures every account, so the
 * footer shows the serving account's 5h and weekly figures whichever account it is.
 * ponytail: reads pi-rotate's state file (its own format); an exported event would
 * decouple them, add it when that format changes.
 */
let rotateCache: { file: string; mtimeMs: number; rows: unknown } | undefined;
export function rotateUsageFor(slotId: string, file: string): ProviderUsageSnapshot | undefined {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (!rotateCache || rotateCache.file !== file || rotateCache.mtimeMs !== mtimeMs) {
      rotateCache = { file, mtimeMs, rows: JSON.parse(readFileSync(file, "utf8")) };
    }
  } catch {
    return undefined;
  }
  const rows = rotateCache.rows;
  const row: any = Array.isArray(rows) ? rows.find((r: any) => r?.slotId === slotId) : undefined;
  // Model-scoped windows (`7d:Fable`) apply to one model only; the account-wide ones are what bind.
  const window = (label: string) => row?.windows?.find((w: any) => w?.label === label && !w.scopeModel
    && Number.isFinite(w.usedPercent));
  const five = window("5h");
  const week = window("7d");
  if (!five || !week) return undefined;
  return {
    provider: slotId,
    primary: { label: "5h", usedPercent: five.usedPercent, resetAt: five.resetAt },
    secondary: { label: "week", usedPercent: week.usedPercent, resetAt: week.resetAt },
    fetchedAt: row.fetchedAt,
  };
}

const STALE_AFTER_MS = 15 * 60_000;
const windowName = (label: string) => (/^(7d|weekly)$/i.test(label) ? "week" : label);
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Format the compact footer value: each figure says it is USED and which window it is,
 * because a bare "5h 37% · 7d 10%" beside pi-rotate's "% left" read as the opposite.
 */
export function formatProviderUsage(usage: ProviderUsageSnapshot, now = Date.now()): string {
  const { primary, secondary } = usage;
  const resets = primary.resetAt && primary.resetAt > now ? ` (resets ${clock(primary.resetAt)})` : "";
  const age = usage.fetchedAt && now - usage.fetchedAt > STALE_AFTER_MS
    ? ` · measured ${Math.round((now - usage.fetchedAt) / 60_000)}m ago` : "";
  return `${windowName(primary.label)} ${formatPercent(primary.usedPercent)}% used${resets} · `
    + `${windowName(secondary.label)} ${formatPercent(secondary.usedPercent)}% used${age}`;
}

/** The fresher of two readings for the same account; either may be missing. */
export function fresherUsage(a: ProviderUsageSnapshot | undefined | null, b: ProviderUsageSnapshot | undefined | null) {
  if (!a) return b ?? null;
  if (!b) return a;
  return (b.fetchedAt ?? 0) > (a.fetchedAt ?? 0) ? b : a;
}
