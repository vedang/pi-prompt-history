import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const DEFAULT_HISTORY_DB_PATH =
	"~/.pi/agent/prompt-history/history.db" as const;
export const DEFAULT_SESSION_DIR = "~/.pi/agent/sessions" as const;
export const DEFAULT_MAX_RESULTS = 20;
export const DEFAULT_PRIMARY_ACTION = "copy" as const;

export type PromptHistoryAction = "copy" | "resume";

export type PromptHistoryConfig = {
	dbPath: string;
	sessionDir: string;
	maxResults: number;
	localMode: "cwd";
	primaryAction: PromptHistoryAction;
};

export interface PromptHistoryConfigOptions {
	cwd?: string;
	extensionDir?: string;
	homeDir?: string;
}

type PromptHistoryConfigInput = Partial<{
	dbPath: unknown;
	sessionDir: unknown;
	maxResults: unknown;
	primaryAction: unknown;
}>;

const DEFAULT_EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PROMPT_HISTORY_CONFIG: PromptHistoryConfig = {
	dbPath: DEFAULT_HISTORY_DB_PATH,
	sessionDir: DEFAULT_SESSION_DIR,
	maxResults: DEFAULT_MAX_RESULTS,
	localMode: "cwd",
	primaryAction: DEFAULT_PRIMARY_ACTION,
};

export function expandHomePath(inputPath: string): string {
	if (!inputPath.startsWith("~")) {
		return resolve(inputPath);
	}

	return resolve(inputPath.replace(/^~(?=$|\/)/, homedir()));
}

export function initializePromptHistoryConfig(_ctx?: ExtensionContext): void {
	// Reserved for future user/project config hydration.
}

export function resolvePromptHistoryConfig(
	overrides: PromptHistoryConfigOptions = {},
): PromptHistoryConfig {
	const extensionDir = overrides.extensionDir ?? DEFAULT_EXTENSION_DIR;
	const homeDir = overrides.homeDir ?? homedir();
	const cwd = overrides.cwd ?? process.cwd();

	const extensionConfig = readConfigFile(join(extensionDir, "config.json"));
	const globalConfig = readConfigFile(
		join(homeDir, ".pi", "agent", "extensions", "prompt-history.json"),
	);
	const projectConfig = readConfigFile(
		join(cwd, ".pi", "extensions", "prompt-history.json"),
	);

	return {
		dbPath: resolveFirstValid(
			[projectConfig.dbPath, globalConfig.dbPath, extensionConfig.dbPath],
			resolveString,
			DEFAULT_PROMPT_HISTORY_CONFIG.dbPath,
		),
		sessionDir: resolveFirstValid(
			[
				projectConfig.sessionDir,
				globalConfig.sessionDir,
				extensionConfig.sessionDir,
			],
			resolveString,
			DEFAULT_PROMPT_HISTORY_CONFIG.sessionDir,
		),
		maxResults: resolveFirstValid(
			[
				projectConfig.maxResults,
				globalConfig.maxResults,
				extensionConfig.maxResults,
			],
			resolvePositiveInteger,
			DEFAULT_PROMPT_HISTORY_CONFIG.maxResults,
		),
		localMode: "cwd",
		primaryAction: resolveFirstValid(
			[
				projectConfig.primaryAction,
				globalConfig.primaryAction,
				extensionConfig.primaryAction,
			],
			resolvePrimaryAction,
			DEFAULT_PROMPT_HISTORY_CONFIG.primaryAction,
		),
	};
}

function resolveFirstValid<T>(
	values: unknown[],
	resolveValue: (value: unknown) => T | undefined,
	fallback: T,
): T {
	for (const value of values) {
		const resolved = resolveValue(value);
		if (resolved !== undefined) {
			return resolved;
		}
	}

	return fallback;
}

function readConfigFile(path: string): PromptHistoryConfigInput {
	if (!existsSync(path)) {
		return {};
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as PromptHistoryConfigInput)
			: {};
	} catch {
		return {};
	}
}

function resolveString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePositiveInteger(value: unknown): number | undefined {
	if (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isInteger(value) &&
		value > 0
	) {
		return value;
	}

	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isInteger(parsed) && parsed > 0) {
			return parsed;
		}
	}

	return undefined;
}

function resolvePrimaryAction(value: unknown): PromptHistoryAction | undefined {
	return value === "resume" || value === "copy" ? value : undefined;
}
