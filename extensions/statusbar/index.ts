import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { StatusWorker, type AccountingSnapshot, type AccountingRequest, type UsageSnapshot as FooterUsageSnapshot } from "./status-worker-host.ts";
// The widget catalogue and its two storage layers, shared verbatim with the `pmls` command line.
import { WIDGETS, load as loadVisibility, readLayer as readVisibilityLayer, writeLayer as writeVisibilityLayer, globalFile as visibilityGlobalFile, projectFile as visibilityProjectFile, extensionKey, extensionName, isExtensionKey, writeRoster } from "./visibility.mjs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildInitialPromptFallbackSnapshot,
  envFlag,
  estimateTokensFromCharCount,
  formatTokens,
  formatUserPath,
  pathExists,
  type InitialPromptEstimateSnapshot,
  type InitialPromptInputEstimate,
} from "@firstpick/pi-utils";
import { Container, Key, matchesKey, type SettingItem, SettingsList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  formatProviderUsage,
  parseAnthropicProviderUsage,
  parseCodexProviderUsage,
  type ProviderUsageSnapshot,
  type ProviderUsageWindow,
} from "./provider-usage.ts";

type GitChangeKind = "staged" | "modified" | "untracked" | "conflicted";

type GitChangedFile = {
  kind: GitChangeKind;
  path: string;
  oldPath?: string;
  status: string;
};

type GitSnapshot = {
  branch: string;
  isDetached: boolean;
  upstream?: string;
  upstreamGone: boolean;
  hasRemotes: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changedFiles: GitChangedFile[];
  changedFilesTotal: number;
  changedFilesTruncated: boolean;
  operation?: string;
  stashCount: number;
  submoduleDirty: number;
  lastCommitAge?: string;
  worktreeCount: number;
  headTag?: string;
  signingMismatch: boolean;
};

/** Fields parsed purely from `git status --porcelain=2 --branch` output. */
export type GitPorcelainStatus = {
  branch: string;
  isDetached: boolean;
  upstream?: string;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changedFiles: GitChangedFile[];
};

type SigningDiagnostics = {
  commitSignRequired: boolean;
  signState: string;
  gpgFormat: string;
  signingKey: string;
};

const LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS = 2000;
const SESSION_SPEED_SAMPLE_MIN_INTERVAL_MS = 250;
const SESSION_SPEED_SAMPLE_LIMIT = 20_000;
const DEFAULT_GIT_AUTO_REFRESH_INTERVAL_MS = 10_000;
const GIT_INITIAL_FETCH_TIMEOUT_MS = 30_000;
const GIT_FETCH_MESSAGE_MAX_LENGTH = 240;
const GIT_CHANGED_FILES_LIMIT = 80;
const PROMPT_ESTIMATE_REFRESH_DELAY_MS = 1000;
const FOOTER_USAGE_RECOMPUTE_DELAY_MS = 1000;
const GIT_FOOTER_STATUS_KEY = "pmls";
const FOOTER_VISIBILITY_SETTINGS_FILE_ENV = "PMLS_SETTINGS_FILE";

const FOOTER_VISIBILITY_KEYS = [
  "tokens",
  "cache",
  "pi",
  "speed",
  "speed-avg",
  "speed-low",
  "speed-max",
  "cost",
  "context",
  "usage",
  "model",
  "thinking",
  "cwd",
  "cwd-branch",
  "git-status",
  "extension-statuses",
  "line3-gap",
  "git-branch-indicator",
  "git-detached",
  "git-operation",
  "git-ahead",
  "git-behind",
  "git-upstream",
  "git-staged",
  "git-unstaged",
  "git-untracked",
  "git-conflicted",
  "git-clean",
  "git-stash",
  "git-submodules",
  "git-worktrees",
  "git-tag",
  "git-last-commit-age",
  "git-signing-mismatch",
] as const;

type FooterVisibilityKey = (typeof FOOTER_VISIBILITY_KEYS)[number];

const FOOTER_VISIBILITY_DEFAULTS: Record<FooterVisibilityKey, boolean> = {
  tokens: true,
  cache: true,
  pi: true,
  speed: true,
  "line3-gap": false,
  "speed-avg": false,
  "speed-low": false,
  "speed-max": false,
  cost: true,
  context: true,
  usage: true,
  model: true,
  thinking: true,
  cwd: true,
  "cwd-branch": true,
  "git-status": true,
  "extension-statuses": true,
  "git-branch-indicator": false,
  "git-detached": true,
  "git-operation": true,
  "git-ahead": true,
  "git-behind": true,
  "git-upstream": true,
  "git-staged": true,
  "git-unstaged": true,
  "git-untracked": true,
  "git-conflicted": true,
  "git-clean": true,
  "git-stash": true,
  "git-submodules": true,
  "git-worktrees": true,
  "git-tag": true,
  "git-last-commit-age": true,
  "git-signing-mismatch": true,
};

const FOOTER_VISIBILITY_ALIASES: Record<string, FooterVisibilityKey> = {
  "avg-speed": "speed-avg",
  "speed-average": "speed-avg",
  "speed-1-low": "speed-low",
  "speed-1%-low": "speed-low",
  "speed-onepercent-low": "speed-low",
  "max-speed": "speed-max",
  "speed-spike": "speed-max",
  "branch-indicator": "git-branch-indicator",
  detached: "git-detached",
  operation: "git-operation",
  ahead: "git-ahead",
  behind: "git-behind",
  upstream: "git-upstream",
  staged: "git-staged",
  unstaged: "git-unstaged",
  modified: "git-unstaged",
  untracked: "git-untracked",
  conflicted: "git-conflicted",
  clean: "git-clean",
  stash: "git-stash",
  submodule: "git-submodules",
  submodules: "git-submodules",
  worktrees: "git-worktrees",
  tag: "git-tag",
  age: "git-last-commit-age",
  "last-commit": "git-last-commit-age",
  signing: "git-signing-mismatch",
  "signing-mismatch": "git-signing-mismatch",
};

const FOOTER_VISIBILITY_KEY_SET = new Set<string>(FOOTER_VISIBILITY_KEYS);
const runtimeFooterVisibilityOverrides = new Map<FooterVisibilityKey, boolean>();
const warnedInvalidFooterVisibilityFiles = new Set<string>();

// The file is what it means: segment name to shown/hidden. Absent keys keep their default.
type PersistedFooterVisibilitySettings = Partial<Record<FooterVisibilityKey, boolean>>;

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

export function footerVisibilitySettingsFile(env: Record<string, string | undefined> = process.env): string {
  const configuredFile = env[FOOTER_VISIBILITY_SETTINGS_FILE_ENV]?.trim();
  if (configuredFile) return resolve(expandHomePath(configuredFile));
  const configuredAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir ? resolve(expandHomePath(configuredAgentDir)) : resolve(homedir(), ".pi", "agent");
  return resolve(agentDir, "pmls-visibility.json");
}

function normalizeFooterVisibilityToken(value: string): string {
  return value.trim().toLowerCase().replace(/^--?/, "").replace(/[_\s]+/g, "-");
}

function normalizeFooterVisibilityKey(value: string): FooterVisibilityKey | null {
  const token = normalizeFooterVisibilityToken(value);
  if (FOOTER_VISIBILITY_KEY_SET.has(token)) return token as FooterVisibilityKey;
  return FOOTER_VISIBILITY_ALIASES[token] ?? null;
}

function parseFooterVisibilityList(raw: string | undefined): Set<FooterVisibilityKey> {
  const keys = new Set<FooterVisibilityKey>();
  for (const part of (raw || "").split(/[\s,]+/)) {
    const key = normalizeFooterVisibilityKey(part);
    if (key) keys.add(key);
  }
  return keys;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

function visibilityEnvSuffix(key: FooterVisibilityKey): string {
  return key.replace(/-/g, "_").toUpperCase();
}

function visibilityEnvName(key: FooterVisibilityKey): string {
  return `PMLS_${visibilityEnvSuffix(key)}`;
}

const envFooterVisibilityHidden = parseFooterVisibilityList(process.env.PMLS_HIDE);

const envFooterVisibilityOverrides = new Map<FooterVisibilityKey, boolean>();
for (const key of FOOTER_VISIBILITY_KEYS) {
  const value = envBool(visibilityEnvName(key));
  if (value !== undefined) envFooterVisibilityOverrides.set(key, value);
}

// Precedence, weakest first: built-in default, environment, saved settings.
function footerItemVisible(key: FooterVisibilityKey): boolean {
  let visible = FOOTER_VISIBILITY_DEFAULTS[key] ?? true;
  if (envFooterVisibilityHidden.has(key)) visible = false;
  const env = envFooterVisibilityOverrides.get(key);
  if (env !== undefined) visible = env;
  const saved = runtimeFooterVisibilityOverrides.get(key);
  if (saved !== undefined) visible = saved;
  return visible;
}

function replaceRuntimeFooterVisibility(settings: PersistedFooterVisibilitySettings): void {
  runtimeFooterVisibilityOverrides.clear();
  for (const [key, visible] of Object.entries(settings)) {
    if (typeof visible === "boolean") runtimeFooterVisibilityOverrides.set(key as FooterVisibilityKey, visible);
  }
}

/** Where a write lands. Chosen per command with --project; never remembered between commands. */
let visibilityScopeCwd = process.cwd();

/** Extension names the user has silenced on line 3, resolved from both layers. */
const extensionStatusHidden = new Set<string>();

/**
 * The actual text each extension is publishing, kept so the selector can preview the real line 3.
 * Names alone ("ponytail, telegram") do not tell you how much room something takes; the point of
 * the preview is deciding what to cut, and that needs the text as it appears.
 */
const extensionStatusText = new Map<string, string>();

/**
 * The names publishing status right now, recorded so the `pmls` command line can list them.
 * Written only when the set actually changes: this runs on every repaint.
 */
let lastPublishingSignature = "";
function rememberPublishingExtensions(names: string[]): void {
  const signature = [...new Set(names)].sort().join(",");
  if (signature === lastPublishingSignature) return;
  lastPublishingSignature = signature;
  void writeRoster(names).catch(() => {});
}

async function reloadPersistedFooterVisibility(): Promise<void> {
  // Global first, then the project's own file on top, so a repository can hide one widget
  // without restating every other choice.
  const { global, project } = await loadVisibility({ cwd: visibilityScopeCwd });
  const merged = { ...global, ...project } as Record<string, boolean>;
  extensionStatusHidden.clear();
  for (const [key, value] of Object.entries(merged)) {
    if (isExtensionKey(key) && value === false) extensionStatusHidden.add(extensionName(key));
  }
  replaceRuntimeFooterVisibility(merged as PersistedFooterVisibilitySettings);
}

/**
 * Apply a change to ONE layer and reload. Writing the merged view back would copy a project's
 * decisions into the global default, which is how a per-project override silently becomes
 * everyone's problem.
 */
async function applyVisibilityChange(
  scope: "global" | "project",
  change: (layer: Record<string, boolean>) => void,
): Promise<string> {
  const file = scope === "project" ? visibilityProjectFile(visibilityScopeCwd) : visibilityGlobalFile();
  const layer = { ...(await readVisibilityLayer(file)) } as Record<string, boolean>;
  change(layer);
  await writeVisibilityLayer(file, layer);
  await reloadPersistedFooterVisibility();
  return file;
}




function formatFooterVisibilityState(key: FooterVisibilityKey): string {
  const native = footerItemVisible(key) ? "on" : "off";
  const changed = (FOOTER_VISIBILITY_DEFAULTS[key] ?? true) !== footerItemVisible(key);
  return `${key}: ${native}${changed ? " *" : ""}`;
}

function footerVisibilityUsage(): string {
  return [
    "Usage: /pmls                      open the segment selector",
    "       /pmls show|hide|toggle|reset <key> [key...]",
    "       /pmls status | keys        list segments and their state",
    "       /pmls refresh              re-read git and the prompt estimate",
    "       /pmls debug                diagnostics, including why accounting failed",
    "Native TUI: /pmls opens an interactive selector; Ctrl+S applies changes.",
    "Examples: /pmls hide cost context model",
    "          /pmls toggle speed",
    "          /pmls show speed-avg speed-low speed-max",
    `Saved globally: ${footerVisibilitySettingsFile()}`,
    "Env: PMLS_HIDE=cost,context or PMLS_COST=0",
  ].join("\n");
}

type FooterVisibilitySelectorValue = "enabled" | "disabled";

function footerVisibilityKeyLabel(key: FooterVisibilityKey): string {
  return key
    .split("-")
    .map((part) => part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part)
    .join(" ");
}

function footerVisibilitySelectorValue(key: FooterVisibilityKey): FooterVisibilitySelectorValue {
  return footerItemVisible(key) ? "enabled" : "disabled";
}

function footerVisibilitySelectorDescription(key: FooterVisibilityKey): string {
  const defaultState = FOOTER_VISIBILITY_DEFAULTS[key] ?? true ? "default on" : "default off";
  return `${key} · ${defaultState} · ${footerItemVisible(key) ? "on" : "off"}`;
}

function footerVisibilitySelectorInitialValues(): Record<FooterVisibilityKey, FooterVisibilitySelectorValue> {
  return Object.fromEntries(FOOTER_VISIBILITY_KEYS.map((key) => [key, footerVisibilitySelectorValue(key)])) as Record<FooterVisibilityKey, FooterVisibilitySelectorValue>;
}

function footerVisibilitySelectorCounts(values: Record<FooterVisibilityKey, FooterVisibilitySelectorValue>): string {
  const enabled = FOOTER_VISIBILITY_KEYS.filter((key) => values[key] === "enabled").length;
  return `${enabled}/${FOOTER_VISIBILITY_KEYS.length} enabled`;
}

function footerVisibilitySettingsListTheme(theme: ExtensionCommandContext["ui"]["theme"]) {
  return {
    label: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : text,
    value: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text: string) => theme.fg("muted", text),
    cursor: theme.fg("accent", "› "),
    hint: (text: string) => theme.fg("dim", text),
  };
}

function footerVisibilityBorder(theme: ExtensionCommandContext["ui"]["theme"]) {
  return new (class {
    render(width: number) {
      return [theme.fg("accent", "─".repeat(Math.max(0, width)))];
    }
    invalidate() {}
  })();
}

function renderFooterVisibilitySettingsList(settingsList: SettingsList, width: number): string[] {
  const lines = settingsList.render(width);
  const hintIndex = lines.findIndex((line) => line.includes("Type to search") && line.includes("Enter/Space") && line.includes("Esc"));
  if (hintIndex < 0) return lines;
  const filtered = [...lines];
  filtered.splice(hintIndex, 1);
  if (hintIndex > 0 && visibleWidth(filtered[hintIndex - 1] ?? "") === 0) filtered.splice(hintIndex - 1, 1);
  return filtered;
}

/**
 * An example of the bar as currently chosen, drawn from each widget's sample text.
 *
 * A list of names does not tell you what you are turning off. This does: toggle a widget and the
 * line it belongs to loses that piece, at the width of the terminal you are sitting in — which is
 * the whole reason someone opens this on a narrow screen. The data is illustrative, not live,
 * so the preview is identical whatever the session happens to be doing.
 */
function renderFooterVisibilityPreview(
  selected: Record<string, FooterVisibilitySelectorValue>,
  theme: ExtensionCommandContext["ui"]["theme"],
  width: number,
): string[] {
  const separators: Record<number, string> = { 1: "  │  ", 2: "  ·  ", 3: "  " };
  const lines: string[] = [theme.fg("dim", "Preview — lines 1-2 use example numbers, line 3 is your real extensions")];
  for (const lineNumber of [1, 2, 3]) {
    const pieces = WIDGETS.filter((w) => w.line === lineNumber && selected[w.key] === "enabled")
      .map((w) => w.sample);
    if (lineNumber === 3 && selected["line3-gap"] === "enabled") lines.push("");
    if (lineNumber === 3) {
      // The real thing, not an example: line 3 is whatever your other extensions are printing
      // right now, so what you see here is exactly what you are keeping or cutting.
      pieces.length = 0;
      for (const [key, value] of Object.entries(selected)) {
        if (!isExtensionKey(key) || value !== "enabled") continue;
        const name = extensionName(key);
        pieces.push(extensionStatusText.get(name) ?? name);
      }
    }
    const text = pieces.length === 0
      ? theme.fg("dim", "(nothing on this line)")
      : pieces.join(separators[lineNumber] ?? "  ");
    // Truncated exactly as the real bar would truncate it, so an overflowing line looks overflowing.
    lines.push(truncateToWidth(text, width));
  }
  lines.push("");
  return lines;
}

type SelectorResult = { selected: Record<string, FooterVisibilitySelectorValue>; scope: "global" | "project" };

async function openFooterVisibilitySelector(
  ctx: ExtensionCommandContext,
  startScope: "global" | "project",
): Promise<SelectorResult | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/pmls select requires the native Pi TUI. Use explicit show/hide/toggle commands otherwise.", "warning");
    return undefined;
  }

  const initial = footerVisibilitySelectorInitialValues();
  const selected: Record<string, FooterVisibilitySelectorValue> = { ...initial };
  // Whoever is publishing on line 3 right now, so they can be switched off by name.
  const liveExtensions = [...lastPublishingSignature.split(",")].filter(Boolean);
  for (const name of liveExtensions) {
    selected[extensionKey(name)] = extensionStatusHidden.has(name) ? "disabled" : "enabled";
  }

  // Which layer a save lands in. Switching mid-edit re-reads that layer, because "what is on"
  // differs between them: a project can turn something back on that the global default hides.
  let scope = startScope;
  const layerValues = async (target: "global" | "project") => {
    const { global, project } = await loadVisibility({ cwd: visibilityScopeCwd });
    const merged = target === "project" ? { ...global, ...project } : { ...global };
    for (const key of FOOTER_VISIBILITY_KEYS) {
      const value = merged[key];
      selected[key] = (value ?? (FOOTER_VISIBILITY_DEFAULTS[key] ?? true)) ? "enabled" : "disabled";
    }
    for (const name of liveExtensions) {
      const value = merged[extensionKey(name)];
      selected[extensionKey(name)] = value === false ? "disabled" : "enabled";
    }
  };

  return await ctx.ui.custom<SelectorResult | undefined>((tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      ...FOOTER_VISIBILITY_KEYS.map((key) => ({
        id: key,
        label: footerVisibilityKeyLabel(key),
        description: footerVisibilitySelectorDescription(key),
        currentValue: selected[key],
        values: ["enabled", "disabled"],
      })),
      ...liveExtensions.map((name) => ({
        id: extensionKey(name),
        label: `Line 3 · ${name}`,
        description: extensionStatusText.get(name) ?? `Status text published by ${name}`,
        currentValue: selected[extensionKey(name)],
        values: ["enabled", "disabled"],
      })),
    ];

    const container = new Container();
    container.addChild(footerVisibilityBorder(theme));
    container.addChild(
      new (class {
        render(width: number) {
          const where = scope === "project"
            ? `this project · ${visibilityProjectFile(visibilityScopeCwd).replace(homedir(), "~")}`
            : `everywhere · ${visibilityGlobalFile().replace(homedir(), "~")}`;
          const title = `Status bar visibility (${footerVisibilitySelectorCounts(selected)})`;
          return [
            truncateToWidth(theme.fg("accent", theme.bold(title)), width),
            truncateToWidth(theme.fg("dim", `Saving to: ${where}   (Tab switches)`), width),
            "",
          ];
        }
        invalidate() {}
      })(),
    );

    container.addChild(
      new (class {
        render(width: number) {
          return renderFooterVisibilityPreview(selected, theme, width);
        }
        invalidate() {}
      })(),
    );

    const settingsList = new SettingsList(
      items,
      10,
      footerVisibilitySettingsListTheme(theme),
      (id, newValue) => {
        const key = isExtensionKey(id) ? id : normalizeFooterVisibilityKey(id);
        if (!key) return;
        selected[key] = newValue === "enabled" ? "enabled" : "disabled";
        // The preview sits above the list; without this it would keep showing the old choice.
        tui.requestRender?.();
      },
      () => done(undefined),
      { enableSearch: true },
    );

    container.addChild(
      new (class {
        render(width: number) {
          return renderFooterVisibilitySettingsList(settingsList, width);
        }
        invalidate() {
          settingsList.invalidate();
        }
      })(),
    );
    container.addChild(
      new (class {
        render(width: number) {
          const help = "Ctrl+S apply • Enter toggles • Tab global/project • type to search • Esc cancel";
          return ["", truncateToWidth(theme.fg("dim", help), width)];
        }
        invalidate() {}
      })(),
    );
    container.addChild(footerVisibilityBorder(theme));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("s")) || data === "\x13") {
          done({ selected, scope });
          return;
        }
        if (data === "\t") {
          scope = scope === "global" ? "project" : "global";
          void layerValues(scope).then(() => tui.requestRender());
          return;
        }
        if (data === "q") {
          done(undefined);
          return;
        }
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

type GitStatusTone = "accent" | "warning" | "muted" | "success" | "error" | "dim";

type GitStatusItem = {
  text: string;
  tone: GitStatusTone;
};

type GitStatusSection = {
  key: "branch" | "sync" | "changes" | "extra";
  items: GitStatusItem[];
};

type GitFetchState = {
  status: "idle" | "fetching" | "ok" | "error" | "skipped";
  startedAt?: number;
  completedAt?: number;
  message?: string;
};

type FooterTelemetry = {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  accountingState: "loading" | "ready" | "stale" | "unavailable";
  accountingFault: string | null;
  speedOutputTokens: number;
  latestTokenSpeed: number | null;
  speedStats: SessionSpeedStats | null;
  promptInjectionTokens: number | null;
  promptInjectionCalibrationSamples: number;
  contextWindow: number;
  contextPercent: number | null;
  contextDisplay: string;
  modelName: string;
  modelProvider: string | null;
  showModelProvider: boolean;
  thinkingLevel: string;
  usingSubscription: boolean;
  // Aligned-footer additions — three lifecycle scopes, matching Claude Code's
  // chain / active / run split (see AccountingSnapshot / ChainSnapshot).
  contextUsedTokens: number | null;
  sessionId: string;
  // "active": the current session id's own file, since its first entry.
  activeAgeMs: number | null;
  activeCost: number;
  activeLocAdded: number;
  activeLocRemoved: number;
  // "run": this client launch only (resets every restart, even with -c/-r).
  runAgeMs: number | null;
  runCost: number;
  runLocAdded: number;
  runLocRemoved: number;
  // "chain": the /fork /clone lineage, ancestors + active. Null when this
  // session has no parent (most sessions never fork) or not yet computed.
  chain: ChainSnapshot | null;
};


type GitRefreshOptions = {
  publishIfUnchanged?: boolean;
};

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

const GIT_AUTO_REFRESH_INTERVAL_MS = envMs("PMLS_AUTO_REFRESH_MS", DEFAULT_GIT_AUTO_REFRESH_INTERVAL_MS);
const GIT_INITIAL_FETCH_ENABLED = envFlag("PMLS_FETCH", true);
const PROMPT_ESTIMATE_ENABLED = !envFlag("PMLS_DISABLE_PROMPT_ESTIMATE", false);

function formatCwd(cwd: string): string {
  return formatUserPath(cwd);
}

function isReasonableTokenSpeed(tokensPerSecond: number): boolean {
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 && tokensPerSecond <= 1000;
}

type LiveTokenSample = {
  timestampMs: number;
  tokens: number;
};

type SessionSpeedStats = {
  avg: number;
  onePercentLow: number;
  max: number;
  sampleCount: number;
};

/**
 * FPS-style stats over live speed samples: mean, mean of the lowest 1% of
 * samples (at least one), and the maximum observed spike.
 */
function computeSessionSpeedStats(samples: number[]): SessionSpeedStats | null {
  if (samples.length === 0) return null;
  let sum = 0;
  let max = 0;
  for (const sample of samples) {
    sum += sample;
    if (sample > max) max = sample;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const lowCount = Math.max(1, Math.floor(sorted.length / 100));
  let lowSum = 0;
  for (let i = 0; i < lowCount; i++) lowSum += sorted[i];
  return {
    avg: sum / samples.length,
    onePercentLow: lowSum / lowCount,
    max,
    sampleCount: samples.length,
  };
}

function emptyFooterUsageSnapshot(): FooterUsageSnapshot {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    historicalTokenSpeed: null,
    locAdded: 0,
    locRemoved: 0,
    firstEntryMs: null,
  };
}

function formatSessionAge(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m`;
  const totalHours = totalMinutes / 60;
  if (totalHours < 24) return `${totalHours.toFixed(1)}h`;
  return `${(totalHours / 24).toFixed(1)}d`;
}

type ChainSnapshot = {
  ageMs: number | null;
  cost: number;
  locAdded: number;
  locRemoved: number;
  approx: boolean;
};

function formatTokenSpeed(tokensPerSecond: number): string {
  if (tokensPerSecond < 100) {
    if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
    return tokensPerSecond.toFixed(2);
  }
  if (tokensPerSecond < 1000) return Math.round(tokensPerSecond).toString();
  if (tokensPerSecond < 10000) return `${(tokensPerSecond / 1000).toFixed(1)}k`;
  if (tokensPerSecond < 1000000) return `${Math.round(tokensPerSecond / 1000)}k`;
  if (tokensPerSecond < 10000000) return `${(tokensPerSecond / 1000000).toFixed(1)}M`;
  return `${Math.round(tokensPerSecond / 1000000)}M`;
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[], timeout = 2000): Promise<string | undefined> {
  const result = await pi.exec("git", args, { cwd, timeout }).catch(() => undefined);
  if (!result || result.code !== 0) return undefined;
  return result.stdout.trim();
}

function compactFetchMessage(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > GIT_FETCH_MESSAGE_MAX_LENGTH ? `${text.slice(0, GIT_FETCH_MESSAGE_MAX_LENGTH - 1)}…` : text;
}

function gitFetchResultMessage(result: { stdout?: string; stderr?: string; code?: number; killed?: boolean }): string {
  const output = compactFetchMessage([result.stderr, result.stdout].filter(Boolean).join("\n"));
  if (output) return output;
  if (result.killed) return "git fetch timed out";
  return result.code === 0 ? "git fetch completed" : `git fetch failed with exit code ${result.code ?? "unknown"}`;
}

function toAgeLabel(epochSeconds: number): string | undefined {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return undefined;

  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (deltaSeconds < 60) return "now";

  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export async function detectGitOperation(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const gitDirRaw = await runGit(pi, cwd, ["rev-parse", "--git-dir"]);
  if (!gitDirRaw) return undefined;

  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(cwd, gitDirRaw);

  if ((await pathExists(resolve(gitDir, "rebase-merge"))) || (await pathExists(resolve(gitDir, "rebase-apply")))) {
    return "REBASING";
  }
  if (await pathExists(resolve(gitDir, "MERGE_HEAD"))) return "MERGING";
  if (await pathExists(resolve(gitDir, "CHERRY_PICK_HEAD"))) return "CHERRY-PICK";
  if (await pathExists(resolve(gitDir, "REVERT_HEAD"))) return "REVERTING";
  if (await pathExists(resolve(gitDir, "BISECT_LOG"))) return "BISECT";

  return undefined;
}

function splitPorcelainFields(line: string, fieldCount: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < fieldCount - 1; index++) {
    const next = line.indexOf(" ", start);
    if (next === -1) break;
    fields.push(line.slice(start, next));
    start = next + 1;
  }
  fields.push(line.slice(start));
  return fields;
}

function parsePorcelainPathField(value: string): { path: string; oldPath?: string } {
  const [path = "", oldPath] = value.split("\t");
  return oldPath ? { path, oldPath } : { path };
}

function addChangedFile(files: GitChangedFile[], kind: GitChangeKind, path: string, status: string, oldPath?: string) {
  const entry: GitChangedFile = { kind, path, status };
  if (oldPath) entry.oldPath = oldPath;
  files.push(entry);
}

function addTrackedChangedFiles(files: GitChangedFile[], xy: string, path: string, oldPath?: string) {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  if (x !== ".") addChangedFile(files, "staged", path, xy, oldPath);
  if (y !== ".") addChangedFile(files, "modified", path, xy, oldPath);
}

export function parseGitPorcelainStatus(stdout: string): GitPorcelainStatus {
  let branch = "";
  let detachedOid: string | undefined;
  let upstream: string | undefined;
  let hasAbLine = false;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  const changedFiles: GitChangedFile[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
      continue;
    }

    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      if (oid && oid !== "(initial)") detachedOid = oid;
      continue;
    }

    if (line.startsWith("# branch.upstream ")) {
      const value = line.slice("# branch.upstream ".length).trim();
      if (value) upstream = value;
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      hasAbLine = true;
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number.parseInt(match[1] ?? "0", 10) || 0;
        behind = Number.parseInt(match[2] ?? "0", 10) || 0;
      }
      continue;
    }

    if (line.startsWith("1 ")) {
      const fields = splitPorcelainFields(line, 9);
      const xy = fields[1] ?? "..";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") staged++;
      if (y !== ".") unstaged++;
      const filePath = fields[8] ?? "";
      if (filePath) addTrackedChangedFiles(changedFiles, xy, filePath);
      continue;
    }

    if (line.startsWith("2 ")) {
      const fields = splitPorcelainFields(line, 10);
      const xy = fields[1] ?? "..";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") staged++;
      if (y !== ".") unstaged++;
      const parsedPath = parsePorcelainPathField(fields[9] ?? "");
      if (parsedPath.path) addTrackedChangedFiles(changedFiles, xy, parsedPath.path, parsedPath.oldPath);
      continue;
    }

    if (line.startsWith("u ")) {
      conflicted++;
      const fields = splitPorcelainFields(line, 11);
      const filePath = fields[10] ?? "";
      if (filePath) changedFiles.push({ kind: "conflicted", path: filePath, status: fields[1] ?? "UU" });
      continue;
    }

    if (line.startsWith("? ")) {
      untracked++;
      const filePath = line.slice(2);
      if (filePath) changedFiles.push({ kind: "untracked", path: filePath, status: "??" });
      continue;
    }
  }

  const isDetached = !branch || branch === "(detached)";
  const resolvedBranch =
    !isDetached
      ? branch
      : detachedOid
        ? `detached@${detachedOid.slice(0, 7)}`
        : "detached";

  // Upstream configured but unresolvable (deleted remote branch): porcelain=2
  // emits branch.upstream without a branch.ab line.
  const upstreamGone = Boolean(upstream) && !hasAbLine;

  return {
    branch: resolvedBranch,
    isDetached,
    upstream,
    upstreamGone,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    changedFiles,
  };
}

type GitAuxInfo = {
  stashCount: number;
  submoduleDirty: number;
  lastCommitEpoch?: number;
  worktreeCount: number;
  headTag?: string;
  signingMismatch: boolean;
  hasRemotes: boolean;
};

// Stash/submodule/worktree/tag/signing state rarely changes between refresh
// ticks; re-running those probes every 10s dominates auto-refresh cost in
// large repos. Reuse them while `git status` output (which includes the HEAD
// oid) is unchanged, bounded by a TTL so out-of-band changes (stash drop, tag
// creation) still surface within a minute.
const GIT_AUX_CACHE_TTL_MS = 60_000;
let gitAuxCache: { key: string; at: number; aux: GitAuxInfo } | null = null;

async function readGitAuxInfo(pi: ExtensionAPI, cwd: string): Promise<GitAuxInfo> {
  const [stashList, lastCommitTs, worktreeList, headTags, commitSignRequiredRaw, headSignState, remotes, toplevel] =
    await Promise.all([
      runGit(pi, cwd, ["stash", "list", "--format=%gd"]),
      runGit(pi, cwd, ["log", "-1", "--format=%ct"]),
      runGit(pi, cwd, ["worktree", "list", "--porcelain"]),
      runGit(pi, cwd, ["tag", "--points-at", "HEAD", "--sort=-creatordate"]),
      runGit(pi, cwd, ["config", "--bool", "--get", "commit.gpgsign"]),
      runGit(pi, cwd, ["log", "-1", "--format=%G?"]),
      runGit(pi, cwd, ["remote"]),
      runGit(pi, cwd, ["rev-parse", "--show-toplevel"]),
    ]);

  // `submodule status --recursive` spawns per submodule and is by far the most
  // expensive probe; skip it entirely for the common no-submodule repo.
  const hasGitmodules = toplevel ? await pathExists(resolve(toplevel, ".gitmodules")) : false;
  const submoduleStatus = hasGitmodules ? await runGit(pi, cwd, ["submodule", "status", "--recursive"]) : undefined;

  const stashCount = stashList ? stashList.split(/\r?\n/).filter(Boolean).length : 0;

  const submoduleDirty = submoduleStatus
    ? submoduleStatus
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith(" "))
        .length
    : 0;

  const worktreeCount = worktreeList
    ? Math.max(
        1,
        worktreeList
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree ")).length,
      )
    : 1;

  const headTag = headTags?.split(/\r?\n/).find(Boolean);

  const lastCommitEpoch = lastCommitTs ? Number.parseInt(lastCommitTs, 10) : undefined;

  const commitSignRequired = commitSignRequiredRaw?.toLowerCase() === "true";
  const signState = headSignState?.trim().toUpperCase();
  const signingMismatch =
    commitSignRequired &&
    (!signState || signState === "N" || signState === "E");

  return {
    stashCount,
    submoduleDirty,
    lastCommitEpoch,
    worktreeCount,
    headTag,
    signingMismatch,
    hasRemotes: Boolean(remotes),
  };
}

export async function readGitSnapshot(pi: ExtensionAPI, cwd: string): Promise<GitSnapshot | null> {
  const result = await pi
    .exec("git", ["status", "--porcelain=2", "--branch"], { cwd, timeout: 3000 })
    .catch(() => undefined);

  if (!result || result.code !== 0) {
    return null;
  }

  const status = parseGitPorcelainStatus(result.stdout);

  // Operation state must stay fresh (conflict UX depends on it); it is cheap
  // (one rev-parse + a few stat calls) compared to the cached aux probes.
  const operation = await detectGitOperation(pi, cwd);

  const auxKey = `${cwd}\u0000${result.stdout}`;
  const now = Date.now();
  let aux: GitAuxInfo;
  if (gitAuxCache && gitAuxCache.key === auxKey && now - gitAuxCache.at < GIT_AUX_CACHE_TTL_MS) {
    aux = gitAuxCache.aux;
  } else {
    aux = await readGitAuxInfo(pi, cwd);
    gitAuxCache = { key: auxKey, at: now, aux };
  }

  const changedFilesTotal = status.changedFiles.length;
  const changedFiles = status.changedFiles.slice(0, GIT_CHANGED_FILES_LIMIT);

  return {
    branch: status.branch,
    isDetached: status.isDetached,
    upstream: status.upstream,
    upstreamGone: status.upstreamGone,
    hasRemotes: aux.hasRemotes,
    ahead: status.ahead,
    behind: status.behind,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
    conflicted: status.conflicted,
    changedFiles,
    changedFilesTotal,
    changedFilesTruncated: changedFilesTotal > changedFiles.length,
    operation,
    stashCount: aux.stashCount,
    submoduleDirty: aux.submoduleDirty,
    lastCommitAge: aux.lastCommitEpoch ? toAgeLabel(aux.lastCommitEpoch) : undefined,
    worktreeCount: aux.worktreeCount,
    headTag: aux.headTag,
    signingMismatch: aux.signingMismatch,
  };
}

async function getSigningDiagnostics(pi: ExtensionAPI, cwd: string): Promise<SigningDiagnostics> {
  const [commitSignRequiredRaw, headSignState, gpgFormatRaw, signingKeyRaw] = await Promise.all([
    runGit(pi, cwd, ["config", "--bool", "--get", "commit.gpgsign"]),
    runGit(pi, cwd, ["log", "-1", "--format=%G?"]),
    runGit(pi, cwd, ["config", "--get", "gpg.format"]),
    runGit(pi, cwd, ["config", "--get", "user.signingkey"]),
  ]);

  return {
    commitSignRequired: commitSignRequiredRaw?.toLowerCase() === "true",
    signState: headSignState?.trim().toUpperCase() || "N",
    gpgFormat: gpgFormatRaw?.trim() || "(default:gpg)",
    signingKey: signingKeyRaw?.trim() || "(not set)",
  };
}

function isWorkingTreeClean(snapshot: GitSnapshot): boolean {
  return (
    snapshot.ahead === 0 &&
    snapshot.behind === 0 &&
    snapshot.staged === 0 &&
    snapshot.unstaged === 0 &&
    snapshot.untracked === 0 &&
    snapshot.conflicted === 0
  );
}

function gitSnapshotFingerprint(snapshot: GitSnapshot | null): string {
  if (!snapshot) return "none";
  return [
    snapshot.branch,
    snapshot.isDetached ? "1" : "0",
    snapshot.upstream ?? "",
    snapshot.upstreamGone ? "1" : "0",
    snapshot.hasRemotes ? "1" : "0",
    snapshot.changedFilesTotal,
    snapshot.changedFilesTruncated ? "1" : "0",
    snapshot.ahead,
    snapshot.behind,
    snapshot.staged,
    snapshot.unstaged,
    snapshot.untracked,
    snapshot.conflicted,
    snapshot.changedFiles.map((file) => `${file.kind}:${file.status}:${file.oldPath ? `${file.oldPath}->` : ""}${file.path}`).join("\u001e"),
    snapshot.operation ?? "",
    snapshot.stashCount,
    snapshot.submoduleDirty,
    snapshot.lastCommitAge ?? "",
    snapshot.worktreeCount,
    snapshot.headTag ?? "",
    snapshot.signingMismatch ? "1" : "0",
  ].join("\u001f");
}

function buildGitStatusSections(snapshot: GitSnapshot): GitStatusSection[] {
  const visible = (key: FooterVisibilityKey) => footerItemVisible(key);
  const branchSection: GitStatusItem[] = [];
  if (visible("git-branch-indicator")) {
    branchSection.push({ text: "", tone: "accent" }, { text: snapshot.branch, tone: "accent" });
  }
  if (visible("git-detached") && snapshot.isDetached) branchSection.push({ text: "⎇", tone: "warning" });
  if (visible("git-operation") && snapshot.operation) branchSection.push({ text: snapshot.operation, tone: "warning" });

  const syncSection: GitStatusItem[] = [];
  if (visible("git-ahead") && snapshot.ahead > 0) syncSection.push({ text: `⇡${snapshot.ahead}`, tone: "muted" });
  if (visible("git-behind") && snapshot.behind > 0) syncSection.push({ text: `⇣${snapshot.behind}`, tone: "muted" });
  if (visible("git-upstream") && !snapshot.isDetached) {
    if (snapshot.upstreamGone) syncSection.push({ text: "upstream gone", tone: "warning" });
    else if (!snapshot.upstream && snapshot.hasRemotes) syncSection.push({ text: "no upstream", tone: "muted" });
  }

  const changesSection: GitStatusItem[] = [];
  if (visible("git-staged") && snapshot.staged > 0) changesSection.push({ text: `+${snapshot.staged}`, tone: "success" });
  if (visible("git-unstaged") && snapshot.unstaged > 0) changesSection.push({ text: `✎${snapshot.unstaged}`, tone: "warning" });
  if (visible("git-untracked") && snapshot.untracked > 0) changesSection.push({ text: `◌${snapshot.untracked}`, tone: "muted" });
  if (visible("git-conflicted") && snapshot.conflicted > 0) changesSection.push({ text: `!${snapshot.conflicted}`, tone: "error" });
  if (visible("git-clean") && isWorkingTreeClean(snapshot)) changesSection.push({ text: "✅", tone: "dim" });

  const extraSection: GitStatusItem[] = [];
  if (visible("git-stash") && snapshot.stashCount > 0) extraSection.push({ text: `⚑${snapshot.stashCount}`, tone: "muted" });
  if (visible("git-submodules") && snapshot.submoduleDirty > 0) extraSection.push({ text: `✖${snapshot.submoduleDirty}`, tone: "warning" });
  if (visible("git-worktrees") && snapshot.worktreeCount > 1) extraSection.push({ text: `📦${snapshot.worktreeCount}`, tone: "muted" });
  if (visible("git-tag") && snapshot.headTag) extraSection.push({ text: `🏷${snapshot.headTag}`, tone: "accent" });
  if (visible("git-last-commit-age") && snapshot.lastCommitAge) extraSection.push({ text: `⏱${snapshot.lastCommitAge}`, tone: "dim" });
  if (visible("git-signing-mismatch") && snapshot.signingMismatch) extraSection.push({ text: "⚠️!", tone: "warning" });

  const sections: GitStatusSection[] = [
    { key: "branch", items: branchSection },
    { key: "sync", items: syncSection },
    { key: "changes", items: changesSection },
    { key: "extra", items: extraSection },
  ];
  return sections.filter((section) => section.items.length > 0);
}

function buildStatusText(ctx: ExtensionContext, snapshot: GitSnapshot): string {
  const t = ctx.ui.theme;
  const sectionSep = t.fg("dim", "│");
  const itemSep = t.fg("dim", "·");
  const sections = buildGitStatusSections(snapshot);

  return sections.length > 0
    ? sections
        .map((section) => section.items.map((item) => t.fg(item.tone, item.text)).join(` ${itemSep} `))
        .join(` ${sectionSep} `)
    : t.fg("dim", "git");
}

function debugHashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function formatDebugToolNames(snapshot: InitialPromptEstimateSnapshot, limit = 16): string {
  const names = snapshot.tools.map((tool) => tool.name).filter(Boolean);
  if (names.length === 0) return "none";
  const shown = names.slice(0, limit).join(", ");
  const remaining = names.length - limit;
  return remaining > 0 ? `${shown}, … +${remaining} more` : shown;
}

function formatPromptEstimateDebugSnapshot(label: string, snapshot: InitialPromptEstimateSnapshot | null): string[] {
  if (!snapshot) return [`${label}: none`];

  const estimate = snapshot.estimate;
  const state = snapshot.settled ? "settled" : "pending";
  const range = estimate.low !== estimate.high ? ` · range ${formatTokens(estimate.low)}–${formatTokens(estimate.high)}` : "";
  const warning = snapshot.warning ? [`  warning: ${snapshot.warning}`] : [];

  return [
    `${label}: ~${formatTokens(estimate.total)} tok (${snapshot.source}, ${state}, attempts=${snapshot.attempts}${range})`,
    `  key: ${snapshot.key}`,
    `  components: prompt=${formatTokens(estimate.promptText)} · tools=${formatTokens(estimate.toolSchemas)} (${estimate.toolCount}) · framing=${formatTokens(estimate.framing)} · uncal=${formatTokens(estimate.uncalibratedTotal)}`,
    `  calibration: ×${estimate.calibrationMultiplier.toFixed(4)} · samples=${estimate.calibrationSamples} · confidence=${estimate.confidence}`,
    `  systemPrompt: ${snapshot.systemPrompt.length} chars · hash=${debugHashText(snapshot.systemPrompt)}`,
    `  tools: ${formatDebugToolNames(snapshot)}`,
    ...warning,
  ];
}

export default function gitFooterStatus(pi: ExtensionAPI) {
  let refreshPromise: Promise<void> | null = null;
  let pendingRefreshOptions: GitRefreshOptions | null = null;
  let currentAssistantStartMs: number | null = null;
  let currentAssistantOutputChars = 0;
  let currentAssistantEstimatedOutputTokens = 0;
  let currentAssistantUsageOutputTokens = 0;
  let currentAssistantLiveTokenSpeed: number | null = null;
  let currentAssistantTokenSamples: LiveTokenSample[] = [];
  let latestMeasuredTokenSpeed: number | null = null;
  let sessionSpeedSamples: number[] = [];
  let lastSessionSpeedSampleMs = 0;
  let footerUsageSnapshot: FooterUsageSnapshot = emptyFooterUsageSnapshot();
  let latestProviderUsage: ProviderUsageSnapshot | null = null;
  let latestGitSnapshot: GitSnapshot | null = null;
  let latestGitSnapshotFingerprint: string | null = null;
  let latestGitFetchState: GitFetchState = { status: "idle" };
  let gitInitialFetchPromise: Promise<void> | null = null;
  let activeSessionSerial = 0;
  let latestPromptEstimateContext: ExtensionContext | null = null;
  // Timers and delayed PI-estimate callbacks can outlive the context that created them.
  // Keep the freshest context so idle git auto-refresh does not republish a stale cwd snapshot.
  let latestFooterContext: ExtensionContext | null = null;
  let latestFooterCwd = "";
  let requestFooterRender: (() => void) | null = null;
  let promptEstimateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let footerUsageRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
  let gitAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  // Non-UI modes (json/print) have no footer consumer; skip all background work.
  let backgroundWorkEnabled = false;
  let accountingSnapshot: AccountingSnapshot | null = null;
  let accountingFault: string | null = null;
  let accountingFile: string | null = null;
  let accountingBoundary = 0;
  let accountingReadPromise: Promise<void> | null = null;
  let accountingRefreshQueued = false;
  let accountingReset = false;
  let memoryCursor = 0;

  // Only the clock and the latest small worker snapshot belong on the UI thread.
  let runStartMs: number | null = null;

  // SESSION HISTORY IS READ IN A PROCESS OF ITS OWN, AND NEVER ON THIS ONE.
  //
  // Reading long transcripts on the UI thread can block keystrokes. The worker
  // reads them and returns only the totals the footer draws.
  const statusWorker = new StatusWorker();
  // The prompt-size figure is an estimate. Its optional correction pass is not wired: nothing
  // records the samples it would need, so it is not read either.
  const getPromptCalibration = (_ctx: ExtensionContext) => null;
  // THE ESTIMATE IS COMPUTED FROM THE LIVE PROMPT, NOT FROM AN EXPORT.
  //
  // The shared service reaches exactness by asking pi to render the whole conversation to HTML
  // and reading the prompt back out of it: measured at 210ms and 579MB peak on a 21MB session,
  // on the thread that handles keystrokes, one second after every session start. The live system
  // prompt and tool list give the same figure within a few percent for free, so this walks that
  // path directly and keeps the export out of the client entirely.
  const promptEstimateService = (() => {
    let snapshot: InitialPromptEstimateSnapshot | null = null;
    const build = (ctx: ExtensionContext): InitialPromptEstimateSnapshot => ({
      ...buildInitialPromptFallbackSnapshot(pi, ctx, getPromptCalibration(ctx)),
      source: "direct",
      settled: true,
    });
    return {
      getSnapshot: () => snapshot,
      getFallbackSnapshot: (ctx: ExtensionContext) => build(ctx),
      clear: () => { snapshot = null; },
      refresh: async (ctx: ExtensionContext) => {
        snapshot = build(ctx);
        rememberFooterContext(ctx);
        requestFooterRender?.();
        return { status: "updated" as const, snapshot };
      },
    };
  })();
  let promptEstimateRefreshPromise: Promise<unknown> | null = null;

  const rememberPromptEstimateContext = (ctx: ExtensionContext) => {
    latestPromptEstimateContext = ctx;
  };

  const rememberFooterContext = (ctx: ExtensionContext): ExtensionContext => {
    const cwd = ctx.cwd || "";
    if (latestFooterCwd && cwd && latestFooterCwd !== cwd) {
      latestGitSnapshot = null;
      latestGitSnapshotFingerprint = null;
    }
    latestFooterCwd = cwd;
    latestFooterContext = ctx;
    rememberPromptEstimateContext(ctx);
    return ctx;
  };

  const getFooterContext = (fallback: ExtensionContext): ExtensionContext => latestFooterContext ?? fallback;

  // A captured pi/command ctx becomes stale after ctx.newSession(), ctx.fork(),
  // ctx.switchSession(), or ctx.reload().
  // Accessing a stale ctx (pi.exec, ctx.ui, ctx.cwd, ...)
  // throws synchronously, which bypasses runGit's `.catch(() => undefined)`
  // (the throw happens before a promise exists) and surfaces as an unhandled
  // rejection from the background timers below, killing the subagent process.
  // Detect it so timer/async refresh paths can stop the dead auto-refresh and
  // swallow instead of crashing.
  const isStaleExtensionContextError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("extension ctx is stale");
  };

  /** Returns true when the error was a stale-ctx error and has been handled. */
  const handleStaleExtensionContext = (error: unknown): boolean => {
    if (!isStaleExtensionContextError(error)) return false;
    stopGitAutoRefresh();
    return true;
  };

  /** Terminal handler for background/timer work: never throws, never rejects. */
  const swallowBackgroundError = (error: unknown): void => {
    if (handleStaleExtensionContext(error)) return;
    if (envFlag("PMLS_DEBUG", false)) {
      console.error("[pmls] background task failed:", error);
    }
  };

  const mergeRefreshOptions = (current: GitRefreshOptions | null, next: GitRefreshOptions = {}): GitRefreshOptions => {
    const merged: GitRefreshOptions = {};
    if ((current === null || current.publishIfUnchanged === false) && next.publishIfUnchanged === false) merged.publishIfUnchanged = false;
    return merged;
  };

  const getEstimateContext = (fallback: ExtensionContext): ExtensionContext => latestPromptEstimateContext ?? fallback;

  const queuePromptInjectionEstimateRefresh = (ctx: ExtensionContext): Promise<unknown> => {
    if (!PROMPT_ESTIMATE_ENABLED) return Promise.resolve(null);
    const estimateCtx = getEstimateContext(ctx);
    promptEstimateRefreshPromise ??= promptEstimateService.refresh(estimateCtx).finally(() => {
      promptEstimateRefreshPromise = null;
    });
    return promptEstimateRefreshPromise;
  };

  const refreshPromptInjectionEstimate = async (ctx: ExtensionContext) => {
    if (!PROMPT_ESTIMATE_ENABLED) return;
    rememberFooterContext(ctx);
    await queuePromptInjectionEstimateRefresh(ctx);
  };

  /**
   * WHAT THE ESTIMATE ACTUALLY DEPENDS ON: the system prompt and the tools offered. Both change when
   * a model or a loadout changes — not when a turn ends.
   */
  const estimateInputsShape = (ctx: ExtensionContext): { promptChars: number; tools: string } => {
    try {
      const prompt = ctx.getSystemPrompt?.() ?? "";
      const tools = (pi as { getTools?: () => Array<{ name?: string }> }).getTools?.() ?? [];
      const model = (ctx as { model?: { id?: string } }).model?.id ?? "";
      return { promptChars: prompt.length, tools: `${model}|${tools.map((t) => t?.name ?? "").sort().join(",")}` };
    } catch {
      return { promptChars: 0, tools: "unreadable" };
    }
  };
  let estimateShapeSeen: { promptChars: number; tools: string } | null = null;
  let estimateRefreshedAtMs = 0;

  const schedulePromptInjectionEstimateRefresh = (ctx: ExtensionContext, delayMs = PROMPT_ESTIMATE_REFRESH_DELAY_MS) => {
    if (!PROMPT_ESTIMATE_ENABLED || promptEstimateRefreshTimer || promptEstimateRefreshPromise) return;
    // THE ESTIMATE IS NOT RECOMPUTED BECAUSE A TURN ENDED.
    //
    // Refreshing it exports the WHOLE SESSION to HTML through the client and reads the file back.
    // Exporting a long session can block the UI thread and delay keystrokes.
    // The value it produces depends on the system prompt and the tool set, so it is refreshed when
    // THOSE change, and otherwise at most once every ten minutes to catch anything unseen.
    // THE SYSTEM PROMPT IS NOT A USABLE KEY HERE. A client that injects anything per turn — a
    // loadout, a reminder, a tick — changes it every turn, so keying on it refreshed every turn and
    // the freeze stayed. What the estimate is FOR is the context-window headroom of this model with
    // these tools: it is refreshed when the model changes, and otherwise on a floor of ten minutes.
    // WHAT IT COSTS DECIDES HOW OFTEN IT IS ASKED, and what it MEANS decides when it must be.
    //
    // The figure is the size of the initial prompt — the system prompt and the tool definitions.
    // A client that injects per turn moves that prompt by a few hundred characters each time, so
    // keying on its exact text refreshed every turn and kept the freeze; ignoring it entirely would
    // leave the figure wrong after a real change. It refreshes when the model or the tool set
    // changes, when the prompt's SIZE moves by more than 2%, and otherwise on a ten-minute floor —
    // so a loadout arriving is seen at once and a turn ending is not paid for.
    const sinceLast = Date.now() - estimateRefreshedAtMs;
    const shape = estimateInputsShape(ctx);
    const changedShape = estimateShapeSeen !== null && estimateShapeSeen.tools !== shape.tools;
    const movedSize = estimateShapeSeen !== null && estimateShapeSeen.promptChars > 0
      && Math.abs(shape.promptChars - estimateShapeSeen.promptChars) / estimateShapeSeen.promptChars > 0.02;
    if (estimateRefreshedAtMs !== 0 && !changedShape && !movedSize && sinceLast < 10 * 60_000) return;
    estimateShapeSeen = shape;
    estimateRefreshedAtMs = Date.now();
    rememberFooterContext(ctx);
    const scheduledSerial = activeSessionSerial;
    promptEstimateRefreshTimer = setTimeout(() => {
      promptEstimateRefreshTimer = null;
      if (scheduledSerial !== activeSessionSerial) return;
      timedHere("estimate:refresh(scheduled)", () => {
        void refreshPromptInjectionEstimate(getEstimateContext(ctx)).catch(swallowBackgroundError);
      });
    }, Math.max(0, delayMs));
    promptEstimateRefreshTimer.unref?.();
  };

  const getFooterPromptInjectionEstimate = (ctx: ExtensionContext): InitialPromptInputEstimate | null => {
    const snapshot = promptEstimateService.getSnapshot();
    if (!snapshot) schedulePromptInjectionEstimateRefresh(ctx);
    // Do not recompute/validate the estimate key from the render path. The key
    // computation walks system prompt/tool schemas and was the dominant startup
    // cost when the footer rendered before the background estimate settled.
    return snapshot?.estimate ?? null;
  };

  const buildFooterTelemetry = (ctx: ExtensionContext): FooterTelemetry => {
    const {
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      totalCost,
      historicalTokenSpeed,
      locAdded,
      locRemoved,
      firstEntryMs,
    } = footerUsageSnapshot;
    const activeOutputTokens = currentAssistantStartMs !== null ? currentAssistantEstimatedOutputTokens : 0;
    const speedOutputTokens = totalOutput + activeOutputTokens;
    const latestTokenSpeed = currentAssistantLiveTokenSpeed ?? latestMeasuredTokenSpeed ?? historicalTokenSpeed;
    const speedStats = computeSessionSpeedStats(sessionSpeedSamples);

    const promptInjectionEstimate = getFooterPromptInjectionEstimate(ctx);
    const contextUsage = ctx.getContextUsage();
    const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const rawContextPercent = typeof contextUsage?.percent === "number" ? contextUsage.percent : null;
    const contextDisplay = rawContextPercent === null
      ? `?/${formatTokens(contextWindow)}`
      : `${rawContextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
    const contextUsedTokens = rawContextPercent === null || !contextWindow
      ? null
      : Math.round((rawContextPercent / 100) * contextWindow);

    const activeAgeMs = firstEntryMs === null ? null : Math.max(0, Date.now() - firstEntryMs);
    const ancestors = accountingSnapshot?.ancestors;
    let chain: ChainSnapshot | null = null;
    if (ancestors?.hasParent) {
      const floorMs = [ancestors.ageFloorMs, firstEntryMs]
        .filter((v): v is number => v !== null)
        .reduce((min, v) => min === null || v < min ? v : min, null as number | null);
      chain = {
        ageMs: floorMs === null ? null : Math.max(0, Date.now() - floorMs),
        cost: ancestors.cost + totalCost,
        locAdded: ancestors.locAdded + locAdded,
        locRemoved: ancestors.locRemoved + locRemoved,
        approx: ancestors.approx,
      };
    }

    return {
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      totalCost,
      accountingState: accountingFault ? (accountingSnapshot ? "stale" : "unavailable") : accountingSnapshot ? "ready" : "loading",
      accountingFault,
      speedOutputTokens,
      latestTokenSpeed,
      speedStats,
      promptInjectionTokens: promptInjectionEstimate?.total ?? null,
      promptInjectionCalibrationSamples: promptInjectionEstimate?.calibrationSamples ?? 0,
      contextWindow,
      contextPercent: rawContextPercent,
      contextDisplay,
      modelName: ctx.model?.id || "no-model",
      modelProvider: ctx.model?.provider || null,
      showModelProvider: ctx.model ? true : false,
      thinkingLevel: pi.getThinkingLevel(),
      usingSubscription: ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false,
      contextUsedTokens,
      sessionId: ctx.sessionManager.getSessionId?.() ?? "",
      activeAgeMs,
      activeCost: totalCost,
      activeLocAdded: locAdded,
      activeLocRemoved: locRemoved,
      runAgeMs: runStartMs === null ? null : Math.max(0, Date.now() - runStartMs),
      runCost: accountingSnapshot?.run.cost ?? 0,
      runLocAdded: accountingSnapshot?.run.locAdded ?? 0,
      runLocRemoved: accountingSnapshot?.run.locRemoved ?? 0,
      chain,
    };
  };

  const getVisibleProviderUsage = (ctx: ExtensionContext): ProviderUsageSnapshot | null => {
    if (!latestProviderUsage) return null;
    const model = ctx.model;
    if (!model) return null;
    // A snapshot is only valid for the provider it was captured from; a model
    // switch to another provider hides it instead of showing stale data.
    if (latestProviderUsage.provider !== model.provider) return null;
    // Anthropic subscription usage is only meaningful for OAuth/subscription auth.
    if (model.provider === "anthropic" && !ctx.modelRegistry.isUsingOAuth(model)) return null;
    return latestProviderUsage;
  };

  /**
   * WHAT THIS COSTS THE CLIENT'S OWN THREAD, when someone is measuring.
   *
   * With `PMLS_TIMING` set, any stretch of work here over 200 ms writes its name and
   * duration to that path. Accounting reads now happen in the worker; this still catches
   * expensive prompt estimates, rendering and other work left on the client's thread.
   */
  let lastHandler = "(none)";
  let lastHandlerAt = 0;
  /** The handler this extension last entered, for a block that would otherwise have no name. */
  const mark = (name: string): void => {
    if (process.env["PMLS_TIMING"] === undefined) return;
    lastHandler = name;
    lastHandlerAt = Date.now();
  };
  /**
   * EVERY BLOCK ON THIS THREAD, WHOEVER CAUSED IT. A beat every 100 ms that reports how late it
   * fired measures the whole loop — if this stays quiet while the window stutters, the stall is not
   * in this extension, and that is worth knowing before anything here is rewritten.
   */
  const watchLoop = (): void => {
    const to = process.env["PMLS_TIMING"];
    if (to === undefined) return;
    let due = Date.now() + 100;
    const beat = setInterval(() => {
      const late = Date.now() - due;
      due = Date.now() + 100;
      if (late >= 200) {
        try {
          appendFileSync(to, `${new Date().toISOString()} ${String(late).padStart(6)}ms EVENT LOOP BLOCKED`
            + ` · last statusbar entry: ${lastHandler} ${Date.now() - lastHandlerAt}ms ago\n`);
        } catch { /* measuring must never break the thing measured */ }
      }
    }, 100);
    beat.unref?.();
  };
  watchLoop();

  const timedHere = <T>(what: string, run: () => T): T => {
    const to = process.env["PMLS_TIMING"];
    if (to === undefined) return run();
    const at = Date.now();
    try { return run(); } finally {
      const took = Date.now() - at;
      if (took >= 200) {
        try {
          appendFileSync(to, `${new Date().toISOString()} ${String(took).padStart(6)}ms ${what}\n`);
        } catch { /* measuring must never break the thing measured */ }
      }
    }
  };

  const scheduleFooterUsageRecompute = (ctx: ExtensionContext, delayMs = FOOTER_USAGE_RECOMPUTE_DELAY_MS, reset = false) => {
    rememberFooterContext(ctx);
    accountingRefreshQueued = true;
    accountingReset ||= reset;
    if (footerUsageRecomputeTimer || accountingReadPromise) return;
    const scheduledSerial = activeSessionSerial;
    footerUsageRecomputeTimer = setTimeout(() => {
      footerUsageRecomputeTimer = null;
      if (scheduledSerial !== activeSessionSerial) return;
      accountingRefreshQueued = false;
      accountingReadPromise = Promise.resolve().then(async () => {
        const footerCtx = getFooterContext(ctx);
        try {
          const request: AccountingRequest = { sessionFile: accountingFile, runBoundary: accountingBoundary, reset: accountingReset };
          accountingReset = false;
          let nextCursor = memoryCursor;
          if (accountingFile === null) {
            // In-memory SDK sessions have no file for the child to read. Hand over only new
            // entries; aggregation still happens in the worker. File-backed sessions never
            // call getEntries here or serialize their transcripts on the UI thread.
            // ponytail: the SDK getter copies its entry list; batch transfers if this mode grows large.
            const entries = footerCtx.sessionManager.getEntries();
            if (entries.length < memoryCursor) request.reset = true;
            if (request.reset) memoryCursor = 0;
            request.entries = entries.slice(memoryCursor);
            request.parentSession = footerCtx.sessionManager.getHeader()?.parentSession;
            nextCursor = entries.length;
          }
          const snapshot = await statusWorker.readAccounting(request);
          if (scheduledSerial !== activeSessionSerial) return;
          accountingSnapshot = snapshot;
          footerUsageSnapshot = snapshot.usage;
          accountingFault = null;
          memoryCursor = nextCursor;
        } catch (error) {
          if (scheduledSerial !== activeSessionSerial) return;
          accountingFault = String((error as Error)?.message ?? error);
          memoryCursor = 0;
          accountingReset = true;
        } finally {
          if (scheduledSerial === activeSessionSerial) {
            accountingReadPromise = null;
            requestFooterRender?.();
            if (accountingRefreshQueued) scheduleFooterUsageRecompute(footerCtx);
          }
        }
      }).catch(swallowBackgroundError);
    }, Math.max(0, delayMs));
    footerUsageRecomputeTimer.unref?.();
  };

  const recordAssistantSpeed = (message: AssistantMessage, endMs = Date.now()): boolean => {
    const outputTokens = message.usage?.output ?? 0;
    if (!outputTokens || currentAssistantStartMs === null || endMs <= currentAssistantStartMs) return false;

    const elapsedSeconds = (endMs - currentAssistantStartMs) / 1000;
    // Filter out impossible values caused by duplicate/misordered lifecycle events.
    if (elapsedSeconds < 0.05 || elapsedSeconds > 60 * 60) return false;

    const speed = outputTokens / elapsedSeconds;
    if (!isReasonableTokenSpeed(speed)) return false;

    latestMeasuredTokenSpeed = speed;
    return true;
  };

  const getRollingLiveTokenSpeed = (nowMs = Date.now()): number | null => {
    const cutoffMs = nowMs - LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS;
    currentAssistantTokenSamples = currentAssistantTokenSamples.filter((sample) => sample.timestampMs >= cutoffMs);

    if (currentAssistantTokenSamples.length === 0) return null;

    const firstSampleMs = currentAssistantTokenSamples[0]?.timestampMs ?? nowMs;
    const windowStartMs = Math.max(currentAssistantStartMs ?? firstSampleMs, cutoffMs);
    const elapsedSeconds = (nowMs - windowStartMs) / 1000;
    if (elapsedSeconds <= 0) return null;

    const tokens = currentAssistantTokenSamples.reduce((sum, sample) => sum + sample.tokens, 0);
    const speed = tokens / elapsedSeconds;
    return isReasonableTokenSpeed(speed) ? speed : null;
  };

  const preserveLiveAssistantSpeed = () => {
    if (currentAssistantLiveTokenSpeed !== null) {
      latestMeasuredTokenSpeed = currentAssistantLiveTokenSpeed;
    }
  };

  const resetLiveAssistantState = () => {
    currentAssistantStartMs = null;
    currentAssistantOutputChars = 0;
    currentAssistantEstimatedOutputTokens = 0;
    currentAssistantUsageOutputTokens = 0;
    currentAssistantLiveTokenSpeed = null;
    currentAssistantTokenSamples = [];
  };

  const refreshOnce = async (ctx: ExtensionContext, options: GitRefreshOptions = {}) => {
    await reloadPersistedFooterVisibility();
    const footerCtx = rememberFooterContext(ctx);
    const refreshCwd = footerCtx.cwd || "";
    const snapshot = await readGitSnapshot(pi, refreshCwd);
    if (latestFooterCwd && refreshCwd && latestFooterCwd !== refreshCwd) return;

    const fingerprint = gitSnapshotFingerprint(snapshot);
    const changed = fingerprint !== latestGitSnapshotFingerprint;
    latestGitSnapshot = snapshot;
    latestGitSnapshotFingerprint = fingerprint;
    if (!changed && options.publishIfUnchanged === false) return;

    if (!snapshot) {
      footerCtx.ui.setStatus(GIT_FOOTER_STATUS_KEY, undefined);
      return;
    }

    footerCtx.ui.setStatus(GIT_FOOTER_STATUS_KEY, buildStatusText(footerCtx, snapshot));
  };

  const refresh = async (ctx: ExtensionContext, options: GitRefreshOptions = {}) => {
    // A stale ctx throws synchronously from ctx.cwd here; because refresh is
    // async, that throw would reject the returned promise before the guarded
    // IIFE below is reachable, and fire-and-forget callers discard the promise.
    try {
      rememberFooterContext(ctx);
    } catch (error) {
      swallowBackgroundError(error);
      return;
    }
    pendingRefreshOptions = mergeRefreshOptions(pendingRefreshOptions, options);
    refreshPromise ??= (async () => {
      try {
        while (pendingRefreshOptions) {
          const nextOptions = pendingRefreshOptions;
          pendingRefreshOptions = null;
          await refreshOnce(getFooterContext(ctx), nextOptions);
        }
      } catch (error) {
        // readGitSnapshot -> pi.exec throws "extension ctx is stale"
        // synchronously when the session that scheduled this auto-refresh was
        // replaced/reloaded. Stop the timer so we stop poking the dead ctx;
        // the next session_start restarts it with a fresh ctx.
        swallowBackgroundError(error);
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const stopGitAutoRefresh = () => {
    if (!gitAutoRefreshTimer) return;
    clearInterval(gitAutoRefreshTimer);
    gitAutoRefreshTimer = null;
  };

  const startGitAutoRefresh = (ctx: ExtensionContext) => {
    rememberFooterContext(ctx);
    stopGitAutoRefresh();
    if (GIT_AUTO_REFRESH_INTERVAL_MS <= 0) return;
    const scheduledSerial = activeSessionSerial;
    gitAutoRefreshTimer = setInterval(() => {
      if (scheduledSerial !== activeSessionSerial) return;
      void refresh(getFooterContext(ctx), { publishIfUnchanged: false }).catch(swallowBackgroundError);
    }, GIT_AUTO_REFRESH_INTERVAL_MS);
    gitAutoRefreshTimer.unref?.();
  };

  const runInitialGitFetch = async (ctx: ExtensionContext, sessionSerial: number) => {
    if (!GIT_INITIAL_FETCH_ENABLED) {
      latestGitFetchState = { status: "skipped", message: "startup fetch disabled by PMLS_FETCH=0" };
      return;
    }
    if (gitInitialFetchPromise || !latestGitSnapshot) return;

    const remotes = await runGit(pi, ctx.cwd, ["remote"], 2000);
    if (sessionSerial !== activeSessionSerial || !remotes) return;

    latestGitFetchState = { status: "fetching", startedAt: Date.now(), message: "git fetch" };
    requestFooterRender?.();

    gitInitialFetchPromise = pi
      .exec("git", ["-c", "credential.interactive=false", "fetch", "--prune"], { cwd: ctx.cwd, timeout: GIT_INITIAL_FETCH_TIMEOUT_MS })
      .then((result) => {
        if (sessionSerial !== activeSessionSerial) return;
        latestGitFetchState = {
          status: result.code === 0 ? "ok" : "error",
          startedAt: latestGitFetchState.startedAt,
          completedAt: Date.now(),
          message: gitFetchResultMessage(result),
        };
      })
      .catch((error) => {
        if (sessionSerial !== activeSessionSerial) return;
        latestGitFetchState = {
          status: "error",
          startedAt: latestGitFetchState.startedAt,
          completedAt: Date.now(),
          message: compactFetchMessage(error instanceof Error ? error.message : String(error)),
        };
      })
      .finally(() => {
        if (sessionSerial !== activeSessionSerial) return;
        gitInitialFetchPromise = null;
        void refresh(ctx).catch(swallowBackgroundError);
        requestFooterRender?.();
      });

    await gitInitialFetchPromise;
  };

  pi.on("session_start", async (_event, ctx) => {
    mark("session_start");
    // The project layer is found from the session's own directory, not from wherever the process
    // happened to start, or a session opened elsewhere would silently use another project's bar.
    visibilityScopeCwd = ctx.cwd ?? process.cwd();
    await reloadPersistedFooterVisibility();
    backgroundWorkEnabled = ctx.hasUI;
    if (!backgroundWorkEnabled) return;
    const sessionSerial = ++activeSessionSerial;
    gitInitialFetchPromise = null;
    latestGitFetchState = { status: "idle" };
    promptEstimateService.clear();
    latestPromptEstimateContext = null;
    latestFooterContext = ctx;
    latestFooterCwd = ctx.cwd || "";
    latestGitSnapshot = null;
    latestGitSnapshotFingerprint = null;
    footerUsageSnapshot = emptyFooterUsageSnapshot();
    latestProviderUsage = null;
    statusWorker.stop();
    accountingSnapshot = null;
    accountingFault = null;
    accountingReadPromise = null;
    accountingRefreshQueued = false;
    accountingReset = false;
    memoryCursor = 0;
    runStartMs = Date.now();
    accountingFile = ctx.sessionManager.getSessionFile() ?? null;
    // Capture the existing prefix before session_start completes, so historical costs never
    // become this run's costs even when the first worker answer arrives after a new response.
    accountingBoundary = accountingFile === null ? ctx.sessionManager.getEntries().length
      : await stat(accountingFile).then((info) => info.size).catch((error) => {
        if (error.code === "ENOENT") return 0;
        accountingFault = "Cannot read the session boundary; reload to retry";
        return -1;
      });
    sessionSpeedSamples = [];
    lastSessionSpeedSampleMs = 0;
    stopGitAutoRefresh();
    scheduleFooterUsageRecompute(ctx);
    schedulePromptInjectionEstimateRefresh(ctx);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const render = () => tui.requestRender();
      requestFooterRender = render;
      const unsub = footerData.onBranchChange(render);

      return {
        dispose() {
          unsub();
          if (requestFooterRender === render) requestFooterRender = null;
        },
        invalidate() {},
        render(width: number): string[] {
          const footerCtx = getFooterContext(ctx);
          const telemetry = buildFooterTelemetry(footerCtx);
          const contextPercentValue = telemetry.contextPercent ?? 0;

          // Same five-tier thresholds as before, extracted to a tone key so both
          // the plain-text fallback and the new bar-track share one source of truth.
          type ContextTone = "success" | "accent" | "muted" | "warning" | "error" | "dim";
          const contextTone: ContextTone =
            telemetry.contextPercent === null ? "dim"
            : contextPercentValue < 50 ? "success"
            : contextPercentValue < 65 ? "accent"
            : contextPercentValue < 75 ? "muted"
            : contextPercentValue < 85 ? "warning"
            : "error";
          const contextPercentStr = theme.fg(contextTone, telemetry.contextDisplay);

          const sectionSep = theme.fg("dim", "│");
          const itemSep = theme.fg("dim", "·");

          // ── LINE 1 — identity/location: model, cwd, git, session id.
          // Same grouping Claude Code's bar uses (model+cwd+git+session
          // on its top line); pi's git badge is kept as-is since it already
          // covers more ground (stash/submodule/worktree/tag/signing) than
          // Claude Code's simpler branch+counts badge.
          // ── LINE 1 — identity/location.
          // Mirror Claude Code's top line exactly: model+version, then
          // 📁 folder, then ⎇ branch+status, then session id. Use the same
          // near-white "text" color for the main line and keep it on one line.
          const thinkingText = footerCtx.model?.reasoning && footerItemVisible("thinking")
            ? telemetry.thinkingLevel === "off"
              ? "thinking off"
              : telemetry.thinkingLevel
            : "";
          const contextWindowText = telemetry.contextWindow > 0 ? `${formatTokens(telemetry.contextWindow)} context` : "";
          const versionText = VERSION ? `v${VERSION}` : "";

          const displayModelName = footerCtx.model?.name || telemetry.modelName;
          let modelBadge = "";
          if (footerItemVisible("model")) {
            const parts: string[] = [displayModelName];
            if (contextWindowText) parts.push(contextWindowText);
            if (versionText) parts.push(versionText);
            if (thinkingText) parts.push(thinkingText);
            const body = parts.join(" ");
            // Claude Code places the provider in the status via the badge color/
            // context, not as text on this line. Keep provider only when it is
            // needed to disambiguate multiple configured providers.
            modelBadge = footerData.getAvailableProviderCount() > 1 && telemetry.modelProvider
              ? `⬢ ${telemetry.modelProvider} ${body}`
              : `⬢ ${body}`;
          } else if (thinkingText) {
            modelBadge = thinkingText;
          }

          const branch = footerItemVisible("cwd-branch") ? footerData.getGitBranch() : null;
          const branchPart = branch ? `⎇ ${branch}` : "";
          const statusParts: string[] = [];
          const gitStatus = footerItemVisible("git-status") ? footerData.getExtensionStatuses().get(GIT_FOOTER_STATUS_KEY) : undefined;
          if (gitStatus) statusParts.push(gitStatus);

          // Every OTHER extension's setStatus() text goes on its own line (3),
          // so foreign segments never shift this bar's own layout.
          // tps is excluded: it is pulled out to line 1 below.
          // Line 3 is other extensions' text. Each gets its own switch, keyed by the name it
          // publishes under, and a name never seen before is shown — silence is opt-in, so a new
          // extension is never invisible just because it arrived after someone configured this.
          const foreignStatuses: string[] = [];
          const publishing: string[] = [];
          for (const [key, value] of footerData.getExtensionStatuses()) {
            if (key === "tps" || key === GIT_FOOTER_STATUS_KEY) continue;
            const name = String(key).toLowerCase();
            publishing.push(name);
            if (!value) continue;
            extensionStatusText.set(name, value);
            if (!footerItemVisible("extension-statuses")) continue;
            if (extensionStatusHidden.has(String(key).toLowerCase())) continue;
            foreignStatuses.push(value);
          }
          rememberPublishingExtensions(publishing);

          // pi-tps-meter status → line 1 (right after session id), matching the
          // request to surface the live TPS gauge on the identity line.
          const tpsStatus = footerData.getExtensionStatuses().get("tps") || "";

          // Speed token counter (this bar's own "⚡ N tok @ X tok/s") moved
          // from the meters line up to line 1 as a validation cross-check next
          // to tps-meter. Built here once so both the line-1 badge and any
          // optional inline stats share one string.
          let speedBadge = "";
          if (footerItemVisible("speed")) {
            const speedValue = telemetry.latestTokenSpeed === null
              ? "— tok/s"
              : `${formatTokenSpeed(telemetry.latestTokenSpeed)} tok/s`;
            const stats = telemetry.speedStats;
            const statParts: string[] = [];
            if (stats) {
              if (footerItemVisible("speed-avg")) statParts.push(`avg ${formatTokenSpeed(stats.avg)}`);
              if (footerItemVisible("speed-low")) statParts.push(`1% ${formatTokenSpeed(stats.onePercentLow)}`);
              if (footerItemVisible("speed-max")) statParts.push(`max ${formatTokenSpeed(stats.max)}`);
            }
            const statsSuffix = statParts.length > 0 ? ` ${itemSep} ${statParts.join(` ${itemSep} `)}` : "";
            speedBadge = `⚡ ${formatTokens(telemetry.speedOutputTokens)} tok @ ${speedValue}${statsSuffix}`;
          }
          const gitBadge = branchPart
            ? statusParts.length > 0
              ? `${branchPart} ${theme.fg("dim", "·")} ${statusParts.join(` ${itemSep} `)}`
              : branchPart
            : statusParts.length > 0
              ? statusParts.join(` ${itemSep} `)
              : "";

          const cwdPath = footerItemVisible("cwd") ? `📁 ${formatCwd(footerCtx.cwd)}` : "";

          const sessionIdBadge = telemetry.sessionId ? `⌁ ${telemetry.sessionId.slice(0, 8)}` : "";

          const identityParts = [modelBadge, cwdPath, gitBadge, sessionIdBadge, tpsStatus, speedBadge].filter(Boolean);
          const identitySep = `  ${theme.fg("dim", sectionSep)}  `;
          const identityLine = identityParts.join(identitySep);

          // ── LINE 2 — meters: everything usage/cost/context related. Pi-only
          // metrics (tokens, cache, PI: estimate, speed, provider window) have no
          // Claude Code equivalent and are kept unchanged. Cost and context are
          // upgraded to carry the same information Claude Code's meters line
          // carries (age, added/removed lines, used/max token counts, a bar)
          // instead of duplicating a second, thinner version alongside them.
          const segments: string[] = [];

          // Claude Code's meters line sequence, reproduced in the same order:
          // context first, then the lifecycle scopes (chain, active, run) —
          // each "label age / $cost / +add−rem", joined with the same "·"
          // separator Claude Code uses between them (distinct from line 1's "│").
          if (footerItemVisible("context")) {
            if (telemetry.contextUsedTokens !== null && telemetry.contextWindow > 0) {
              const barWidth = 10;
              const frac = Math.max(0, Math.min(1, contextPercentValue / 100));
              let filled = Math.round(frac * barWidth);
              if (frac > 0 && frac < 1) filled = Math.min(Math.max(filled, 1), barWidth - 1);
              const bar = theme.fg(contextTone, "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
              const counts = `${formatTokens(telemetry.contextUsedTokens)}/${formatTokens(telemetry.contextWindow)} (${contextPercentValue.toFixed(0)}%)`;
              segments.push(`${theme.fg("muted", "◧")} context ${bar} ${theme.fg("dim", counts)}`);
            } else {
              segments.push(`${theme.fg("muted", "◧")} context ${contextPercentStr}`);
            }
          }

          const buildScope = (
            icon: string,
            label: string,
            ageMs: number | null,
            cost: number,
            locAdded: number,
            locRemoved: number,
            approx: boolean,
          ): string | null => {
            const parts: string[] = [];
            if (ageMs !== null) parts.push(formatSessionAge(ageMs));
            parts.push(`${approx ? "~" : ""}$${cost.toFixed(2)}`);
            if (locAdded || locRemoved) {
              const tilde = approx ? "~" : "";
              parts.push(`${tilde}${theme.fg("success", `+${locAdded}`)}${theme.fg("error", `−${locRemoved}`)}`);
            }
            if (parts.length === 0) return null;
            return `${theme.fg("muted", icon)} ${label} ${parts.join(" / ")}`;
          };

          // A failure names itself on the bar. Hiding it behind recomputed numbers would also
          // hide the defect: the blank chip is what got this reported in the first place.
          if (footerItemVisible("cost") && telemetry.accountingState !== "ready") {
            const note = telemetry.accountingState === "loading" ? "…"
              : telemetry.accountingState === "stale" ? `stale: ${telemetry.accountingFault ?? "unknown reason"}`
              : `unavailable: ${telemetry.accountingFault ?? "unknown reason"}`;
            segments.push(`◉ accounting ${note}`);
          }
          if (footerItemVisible("cost") && telemetry.chain) {
            const chainScope = buildScope("⛓", "chain", telemetry.chain.ageMs, telemetry.chain.cost, telemetry.chain.locAdded, telemetry.chain.locRemoved, telemetry.chain.approx);
            if (chainScope) segments.push(chainScope);
          }
          if (footerItemVisible("cost") && (telemetry.activeCost || telemetry.usingSubscription)) {
            const activeScope = buildScope("◉", "active", telemetry.activeAgeMs, telemetry.activeCost, telemetry.activeLocAdded, telemetry.activeLocRemoved, false);
            if (activeScope) segments.push(activeScope);
          }
          if (footerItemVisible("cost") && accountingSnapshot !== null && telemetry.runAgeMs !== null) {
            const runScope = buildScope("▶", "run", telemetry.runAgeMs, telemetry.runCost, telemetry.runLocAdded, telemetry.runLocRemoved, false);
            if (runScope) segments.push(runScope);
          }

          // Pi-only telemetry with no Claude Code equivalent — appended after the
          // aligned block instead of interleaved, so the part that mirrors
          // Claude Code stays contiguous and in Claude Code's own order.
          const ioItems: string[] = [];
          if (footerItemVisible("tokens")) {
            if (telemetry.totalInput) ioItems.push(`↑${formatTokens(telemetry.totalInput)}`);
            if (telemetry.totalOutput) ioItems.push(`↓${formatTokens(telemetry.totalOutput)}`);
          }
          if (ioItems.length > 0) segments.push(`${theme.fg("muted", "🪙")} ${ioItems.join(` ${itemSep} `)}`);

          const cacheItems: string[] = [];
          if (footerItemVisible("cache") && (telemetry.totalCacheRead || telemetry.totalCacheWrite)) {
            cacheItems.push(`R${formatTokens(telemetry.totalCacheRead)}`, `W${formatTokens(telemetry.totalCacheWrite)}`);
          }
          if (cacheItems.length > 0) segments.push(`${theme.fg("muted", "💾")} ${cacheItems.join(` ${itemSep} `)}`);

          if (footerItemVisible("pi")) segments.push(telemetry.promptInjectionTokens === null ? "PI: …" : `PI: ${formatTokens(telemetry.promptInjectionTokens)} tok`);

          // speed segment moved to line 1 (see speedBadge above) — not
          // duplicated here on the meters line.

          const providerUsage = getVisibleProviderUsage(footerCtx);
          if (footerItemVisible("usage") && providerUsage) {
            segments.push(`${theme.fg("muted", "📊")} ${formatProviderUsage(providerUsage)}`);
          }

          const metersSep = `  ${theme.fg("dim", "·")}  `;
          const metersLine = segments.join(metersSep);

          // Line 1 is the primary "where am I" information, so it uses the
          // default terminal "text" (near-white). Line 2 is secondary meters,
          // so it stays dim.
          const lines = [
            truncateToWidth(theme.fg("text", identityLine), width),
            truncateToWidth(theme.fg("dim", metersLine), width),
          ];
          if (foreignStatuses.length > 0) {
            // Optional breathing room before other extensions' line. Off by default: a blank row
            // is a whole row of terminal, which is exactly what someone on a short window cannot
            // spare — and the people who want the separation know who they are.
            if (footerItemVisible("line3-gap")) lines.push("");
            lines.push(truncateToWidth(foreignStatuses.join("  "), width));
          }
          return lines;
        },
      };
    });

    void refresh(ctx)
      .then(() => runInitialGitFetch(ctx, sessionSerial))
      .catch(swallowBackgroundError);
    startGitAutoRefresh(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    mark("agent_start");
    if (!backgroundWorkEnabled) return;
    schedulePromptInjectionEstimateRefresh(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    mark("agent_end");
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    preserveLiveAssistantSpeed();
    resetLiveAssistantState();
    timedHere("agent_end:render", () => requestFooterRender?.());
    timedHere("agent_end:estimate", () => schedulePromptInjectionEstimateRefresh(ctx));
    timedHere("agent_end:git", () => { void refresh(ctx).catch(swallowBackgroundError); });
    // Ask the worker for newly appended entries; never rescan history on this thread.
    timedHere("agent_end:usage", () => scheduleFooterUsageRecompute(ctx));
  });

  pi.on("message_start", (event, ctx) => {
    mark("message_start");
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    if (event.message.role === "assistant") {
      currentAssistantStartMs = Date.now();
      currentAssistantOutputChars = 0;
      currentAssistantEstimatedOutputTokens = 0;
      currentAssistantUsageOutputTokens = 0;
      currentAssistantLiveTokenSpeed = null;
      currentAssistantTokenSamples = [];
    }
  });

  pi.on("message_update", (event, ctx) => {
    mark("message_update");
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    if (event.message.role !== "assistant" || currentAssistantStartMs === null) return;

    const streamEvent = event.assistantMessageEvent;
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta" &&
      streamEvent.type !== "toolcall_delta"
    ) {
      return;
    }

    const nowMs = Date.now();
    currentAssistantOutputChars += streamEvent.delta.length;

    const usageOutputTokens = streamEvent.partial.usage?.output;
    let newTokens = 0;
    if (typeof usageOutputTokens === "number" && usageOutputTokens > currentAssistantUsageOutputTokens) {
      newTokens = usageOutputTokens - currentAssistantUsageOutputTokens;
      currentAssistantUsageOutputTokens = usageOutputTokens;
      currentAssistantEstimatedOutputTokens = usageOutputTokens;
    } else if (currentAssistantUsageOutputTokens <= 0) {
      const estimatedOutputTokens = estimateTokensFromCharCount(currentAssistantOutputChars);
      newTokens = Math.max(0, estimatedOutputTokens - currentAssistantEstimatedOutputTokens);
      currentAssistantEstimatedOutputTokens = estimatedOutputTokens;
    }

    if (newTokens > 0) {
      currentAssistantTokenSamples.push({ timestampMs: nowMs, tokens: newTokens });
    }

    currentAssistantLiveTokenSpeed = getRollingLiveTokenSpeed(nowMs);
    if (
      currentAssistantLiveTokenSpeed !== null &&
      nowMs - lastSessionSpeedSampleMs >= SESSION_SPEED_SAMPLE_MIN_INTERVAL_MS
    ) {
      lastSessionSpeedSampleMs = nowMs;
      sessionSpeedSamples.push(currentAssistantLiveTokenSpeed);
      if (sessionSpeedSamples.length > SESSION_SPEED_SAMPLE_LIMIT) {
        sessionSpeedSamples.splice(0, sessionSpeedSamples.length - SESSION_SPEED_SAMPLE_LIMIT);
      }
    }
    preserveLiveAssistantSpeed();
  });

  pi.on("message_end", (event, ctx) => {
    mark("message_end");
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    if (event.message.role === "assistant") {
      const assistantMessage = event.message as AssistantMessage;
      preserveLiveAssistantSpeed();
      recordAssistantSpeed(assistantMessage);
      resetLiveAssistantState();
    }
    scheduleFooterUsageRecompute(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    mark("turn_end");
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    // Disk accounting runs after final messages are persisted, including late usage.
    if (event.message.role === "assistant") {
      const assistantMessage = event.message as AssistantMessage;
      preserveLiveAssistantSpeed();
      recordAssistantSpeed(assistantMessage);
      resetLiveAssistantState();
    }
    requestFooterRender?.();
    schedulePromptInjectionEstimateRefresh(ctx);
    void refresh(ctx).catch(swallowBackgroundError);
    scheduleFooterUsageRecompute(ctx);
  });

  const rebuildAccounting = (_event: unknown, ctx: ExtensionContext) => {
    if (backgroundWorkEnabled) scheduleFooterUsageRecompute(ctx, 0, true);
  };
  pi.on("session_tree", rebuildAccounting);
  pi.on("session_compact", rebuildAccounting);

  pi.on("after_provider_response", (event, ctx) => {
    mark("after_provider_response");
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    const footerCtx = getFooterContext(ctx);
    const model = footerCtx.model;
    const provider = model?.provider;
    // Passive last-seen capture only: supported providers overwrite the
    // snapshot (or clear it on absent/malformed headers so we never show
    // guessed data); other providers leave it untouched and render gating
    // keeps it hidden.
    if (provider === "openai-codex") {
      latestProviderUsage = parseCodexProviderUsage(event.headers) ?? null;
    } else if (provider === "anthropic" && model && footerCtx.modelRegistry.isUsingOAuth(model)) {
      latestProviderUsage = parseAnthropicProviderUsage(event.headers) ?? null;
    } else {
      return;
    }
    requestFooterRender?.();
  });

  pi.on("model_select", (_event, ctx) => {
    mark("model_select");
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    // Model switches re-evaluate provider/auth gating; incompatible snapshots
    // are hidden by getVisibleProviderUsage without a new provider response.
    requestFooterRender?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    backgroundWorkEnabled = false;
    activeSessionSerial += 1;
    gitInitialFetchPromise = null;
    latestGitFetchState = { status: "idle" };
    stopGitAutoRefresh();
    if (promptEstimateRefreshTimer) {
      clearTimeout(promptEstimateRefreshTimer);
      promptEstimateRefreshTimer = null;
    }
    if (footerUsageRecomputeTimer) {
      clearTimeout(footerUsageRecomputeTimer);
      footerUsageRecomputeTimer = null;
    }
    latestGitSnapshotFingerprint = null;
    latestFooterContext = null;
    latestFooterCwd = "";
    // A session switch (/new, /resume, /fork, /clone) starts a new "run" and
    // invalidates any cached lineage — both must be rebuilt against whatever
    // session comes next, not silently carried over.
    statusWorker.stop();
    runStartMs = null;
    accountingSnapshot = null;
    accountingFault = null;
    accountingReadPromise = null;
    accountingRefreshQueued = false;
    accountingReset = false;
    memoryCursor = 0;
    try {
      ctx.ui.setStatus(GIT_FOOTER_STATUS_KEY, undefined);
      ctx.ui.setFooter(undefined);
    } catch (error) {
      // Shutdown can race context invalidation.
      swallowBackgroundError(error);
    }
  });

  const refreshCommand = async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const silent = /(?:^|\s)--silent(?:\s|$)/.test(args || "");
        rememberFooterContext(ctx);
        scheduleFooterUsageRecompute(ctx, 0, true);
        await refreshPromptInjectionEstimate(ctx);
        await refresh(ctx);
        if (!silent) ctx.ui.notify("Status bar refreshed", "info");
      } catch (error) {
        // The command can already be in flight when /new replaces the session.
        // There is no replacement ctx in this old command frame, so stop its
        // background polling and let the fresh session_start redraw instead of
        // surfacing an extension error.
        if (handleStaleExtensionContext(error)) return;
        throw error;
      }
  };

  const visibilityCommand = async (args: string, ctx: ExtensionCommandContext) => {
      rememberFooterContext(ctx);
      visibilityScopeCwd = ctx.cwd ?? process.cwd();
      await reloadPersistedFooterVisibility();
      const allTokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const scope: "global" | "project" = allTokens.some((t) => t === "--project" || t === "-p") ? "project" : "global";
      const tokens = allTokens.filter((t) => t !== "--project" && t !== "-p");
      const firstToken = tokens.shift();
      const command = normalizeFooterVisibilityToken(firstToken || "");

      const openSelector = async () => {
        const result = await openFooterVisibilitySelector(ctx, scope);
        if (!result) {
          ctx.ui.notify("Selector cancelled.", "info");
          return;
        }
        const { selected, scope: target } = result;

        // RECORD ONLY WHAT DIFFERS FROM THE LAYER BENEATH. Writing every widget into a project
        // file would freeze 33 decisions there, so a later change to the global default would
        // stop reaching that project — the opposite of what an override is for.
        const { global } = await loadVisibility({ cwd: visibilityScopeCwd });
        const baseline = (key: string): boolean => {
          if (target === "project" && global[key] !== undefined) return global[key];
          if (target === "global" && isExtensionKey(key)) return true;
          return isExtensionKey(key) ? true : (FOOTER_VISIBILITY_DEFAULTS[key as FooterVisibilityKey] ?? true);
        };
        const decided: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(selected)) {
          const wanted = value === "enabled";
          if (wanted !== baseline(key)) decided[key] = wanted;
        }

        const file = await applyVisibilityChange(target, (layer) => {
          for (const key of Object.keys(layer)) {
            if (FOOTER_VISIBILITY_KEYS.includes(key as FooterVisibilityKey) || isExtensionKey(key)) delete layer[key];
          }
          Object.assign(layer, decided);
        });
        requestFooterRender?.();
        await refresh(ctx);
        const count = Object.keys(decided).length;
        ctx.ui.notify(`Saved to the ${target} setting · ${count} widget(s) recorded\n${file}`, "info");
      };

      if (!firstToken && ctx.mode === "tui") {
        await openSelector();
        return;
      }

      if (command === "select" || command === "selector" || command === "tui" || command === "ui") {
        if (tokens.length > 0) {
          ctx.ui.notify(footerVisibilityUsage(), "warning");
          return;
        }
        await openSelector();
        return;
      }

      if (command === "help" || command === "--help" || command === "-h") {
        ctx.ui.notify(footerVisibilityUsage(), "info");
        return;
      }

      if (command === "keys" || command === "list") {
        // The same catalogue the command line prints: what each widget puts on screen, what it
        // means, and which layer decided it — so nobody has to guess why something is missing.
        const { state, globalFile: gFile, projectFile: pFile } = await loadVisibility({ cwd: visibilityScopeCwd });
        const lines: string[] = [`global  ${gFile}`, `project ${pFile}`, ""];
        let line = 0;
        for (const widget of WIDGETS) {
          if (widget.line !== line) { line = widget.line; lines.push(`── line ${line} ──`); }
          const decided = state[widget.key];
          const from = decided.source === "default" ? "" : ` (set in ${decided.source})`;
          lines.push(`${decided.value ? "[x]" : "[ ]"} ${widget.key}  ${widget.sample}`);
          lines.push(`    ${widget.what}${from}`);
        }
        const live = [...lastPublishingSignature.split(",")].filter(Boolean);
        if (live.length > 0) {
          lines.push("── line 3 · other extensions ──");
          for (const name of live) {
            const hidden = extensionStatusHidden.has(name);
            lines.push(`${hidden ? "[ ]" : "[x]"} ${name}`);
            lines.push(`    Status text published by ${name}${hidden ? " (hidden here)" : ""}`);
          }
        }
        lines.push("", "/pmls hide <widget>            everywhere", "/pmls hide <widget> --project  only this project",
          "/pmls reset [--project]        clear every choice in that layer");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (command === "status" || command === "") {
        ctx.ui.notify(`Status bar segments (* differs from default):\n${FOOTER_VISIBILITY_KEYS.map(formatFooterVisibilityState).join("\n")}`, "info");
        return;
      }

      if (!["show", "hide", "toggle", "reset"].includes(command)) {
        ctx.ui.notify(footerVisibilityUsage(), "warning");
        return;
      }

      const known = [...lastPublishingSignature.split(",")].filter(Boolean);
      const keys = tokens.map((token) => {
        const lower = token.trim().toLowerCase();
        if (isExtensionKey(lower)) return lower as FooterVisibilityKey;
        if (known.includes(lower)) return extensionKey(lower) as FooterVisibilityKey;
        return normalizeFooterVisibilityKey(token);
      });
      const invalidKeys = tokens.filter((token, index) => !keys[index]);
      const validKeys = keys.filter((key): key is FooterVisibilityKey => Boolean(key));
      if (invalidKeys.length > 0) {
        ctx.ui.notify(`Unknown git footer visibility key(s): ${invalidKeys.join(", ")}\n\n${footerVisibilityUsage()}`, "warning");
        return;
      }

      if (command !== "reset" && validKeys.length === 0) {
        ctx.ui.notify(footerVisibilityUsage(), "warning");
        return;
      }

      const wanted = new Map<FooterVisibilityKey, boolean>();
      for (const key of validKeys) {
        wanted.set(key, command === "show" ? true : command === "hide" ? false : !footerItemVisible(key));
      }
      const file = await applyVisibilityChange(scope, (layer) => {
        if (command === "reset") {
          // A reset with no names clears this layer completely, including per-extension switches,
          // so "reset" means what it says rather than "reset the parts I remembered to list".
          if (validKeys.length === 0) for (const key of Object.keys(layer)) delete layer[key];
          else for (const key of validKeys) delete layer[key];
          return;
        }
        for (const [key, value] of wanted) layer[key] = value;
      });
      requestFooterRender?.();
      await refresh(ctx);
      const changed = validKeys.length > 0 ? validKeys.map(formatFooterVisibilityState).join("\n") : "every widget reset";
      ctx.ui.notify(`Saved to the ${scope} setting · ${file}\n${changed}`, "info");
  };

  /**
   * Why the signing tick disagrees with your Git config. This used to sit on ctrl+shift+g,
   * which is pi's own alt-screen search binding: every session started with a shortcut
   * conflict warning, and one of the two features had to lose. A diagnostic belongs with the
   * other diagnostics rather than on a chord taken from the editor.
   */
  const signingCommand = async (ctx: ExtensionCommandContext) => {
      rememberFooterContext(ctx);
      const diagnostics = await getSigningDiagnostics(pi, ctx.cwd);
      if (!diagnostics.commitSignRequired) {
        ctx.ui.notify("Signing mismatch: commit.gpgsign is OFF", "info");
        return;
      }

      if (!["N", "E"].includes(diagnostics.signState)) {
        ctx.ui.notify("Signing mismatch: not currently triggered", "info");
        return;
      }

      ctx.ui.notify(
        `Signing mismatch details: commit.gpgsign=ON, last-sign-state=${diagnostics.signState}, gpg.format=${diagnostics.gpgFormat}, user.signingkey=${diagnostics.signingKey}`,
        "warning",
      );
    };

  const debugCommand = async (_args: string, ctx: ExtensionCommandContext) => {
      rememberFooterContext(ctx);
      const cachedBefore = promptEstimateService.getSnapshot();
      const fallbackNow = promptEstimateService.getFallbackSnapshot(ctx);
      const refreshResult = await promptEstimateService.refresh(ctx);
      const cachedAfter = promptEstimateService.getSnapshot();
      const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
      const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";

      ctx.ui.notify(
        [
          "pi-multi-line-status diagnostics",
          `model: ${modelLabel}`,
          `session: ${sessionId}`,
          `accounting: ${accountingFault ? `FAILED — ${accountingFault}` : accountingSnapshot ? "worker ok" : "pending"}`,
          `session file: ${accountingFile ?? "(in memory)"}`,
          `runtime: node ${process.versions.node}${process.versions.bun ? ` · bun ${process.versions.bun}` : ""} on ${process.platform}`,
          `worker launched with: ${statusWorker.lastExecPath ?? "(never started)"}`,
          `service refresh: ${refreshResult.status}`,
          "",
          ...formatPromptEstimateDebugSnapshot("footer cached before", cachedBefore),
          "",
          ...formatPromptEstimateDebugSnapshot("live estimate now", fallbackNow),
          "",
          ...formatPromptEstimateDebugSnapshot("footer cached after", cachedAfter),
        ].join("\n"),
        "info",
      );
  };

  // ONE COMMAND, NOT THREE. "git-footer" named a thing this is no longer; three near-identical
  // prefixes made the reader guess which one they wanted. /pmls is the package, and everything
  // it does is a word after it.
  pi.registerCommand("pmls", {
    description: "pi-multi-line-status: show/hide segments, refresh, diagnose",
    handler: async (args, ctx) => {
      const text = (args || "").trim();
      const verb = text.split(/\s+/)[0]?.toLowerCase() ?? "";
      const rest = text.slice(verb.length).trim();
      if (verb === "refresh") return refreshCommand(rest, ctx);
      if (verb === "debug" || verb === "pi-debug") return debugCommand(rest, ctx);
      if (verb === "signing") return signingCommand(ctx);
      return visibilityCommand(text, ctx);
    },
  });

}
