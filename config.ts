import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Shared configuration scaffold for the prompt history extension.
 *
 * Populated in later tasks when runtime knobs are finalized.
 */
export const DEFAULT_HISTORY_DB_PATH =
	"~/.pi/agent/prompt-history/history.db" as const;

export type PromptHistoryConfig = {
	dbPath?: string;
	maxResults?: number;
	localMode?: "cwd";
};

export function initializePromptHistoryConfig(_ctx?: ExtensionContext): void {
	// Intentionally no-op placeholder for now.
}

export function resolvePromptHistoryConfig(): PromptHistoryConfig {
	return {
		dbPath: DEFAULT_HISTORY_DB_PATH,
		maxResults: 200,
		localMode: "cwd",
	};
}
