import type { PromptHistoryEntry } from "./db";

/**
 * Query/lookup module for prompt-history search.
 */
export type SearchScope = "local" | "global";

export interface SearchOptions {
	scope: SearchScope;
	query: string;
	cwd: string;
	limit?: number;
}

export async function searchPrompts(
	_options: SearchOptions,
): Promise<PromptHistoryEntry[]> {
	return [];
}
