/** Types for the shared widget catalogue; the implementation is plain JS so the CLI can run it. */
export type WidgetKey = string;
export type Layer = Record<WidgetKey, boolean>;
export type Decision = { value: boolean; source: "default" | "environment" | "global" | "project" };

export declare const WIDGETS: ReadonlyArray<{ key: WidgetKey; line: number; sample: string; what: string }>;
export declare const KEYS: readonly WidgetKey[];
export declare const DEFAULTS: Readonly<Layer>;

export declare const EXTENSION_KEY_PREFIX: string;
export declare function isExtensionKey(key: string): boolean;
export declare function extensionKey(name: string): string;
export declare function extensionName(key: string): string;
export declare function rosterFile(env?: Record<string, string | undefined>): string;
export declare const ROSTER_FORGET_MS: number;
export declare function readRosterEntries(env?: Record<string, string | undefined>): Promise<Record<string, number>>;
export declare function readRoster(env?: Record<string, string | undefined>, now?: number): Promise<string[]>;
export declare function writeRoster(names: string[], env?: Record<string, string | undefined>, now?: number): Promise<string[]>;
export declare function normalizeKey(token: string, knownExtensions?: string[]): WidgetKey | null;
export declare function globalFile(env?: Record<string, string | undefined>): string;
export declare function projectFile(cwd?: string): string;
export declare function readLayer(file: string): Promise<Layer>;
export declare function writeLayer(file: string, layer: Layer): Promise<Layer>;
export declare function envLayer(env?: Record<string, string | undefined>): Layer;
export declare function effective(input?: { global?: Layer; project?: Layer; env?: Layer; extensions?: string[] }): Record<WidgetKey, Decision>;
export declare function load(input?: { cwd?: string; env?: Record<string, string | undefined>; extensions?: string[] }): Promise<{
  globalFile: string; projectFile: string; global: Layer; project: Layer; env: Layer; extensions: string[];
  state: Record<WidgetKey, Decision>;
}>;
