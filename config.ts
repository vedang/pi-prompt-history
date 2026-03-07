import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const DEFAULT_HISTORY_DB_PATH =
	"~/.pi/agent/prompt-history/history.db" as const;
export const DEFAULT_SESSION_DIR = "~/.pi/agent/sessions" as const;
export const DEFAULT_MAX_RESULTS = 20;

export type PromptHistoryConfig = {
	dbPath: string;
	sessionDir: string;
	maxResults: number;
	localMode: "cwd";
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

export function resolvePromptHistoryConfig(): PromptHistoryConfig {
	return {
		dbPath: DEFAULT_HISTORY_DB_PATH,
		sessionDir: DEFAULT_SESSION_DIR,
		maxResults: DEFAULT_MAX_RESULTS,
		localMode: "cwd",
	};
}
