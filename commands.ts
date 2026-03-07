import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { SearchScope } from "./search";

/**
 * Minimal command entrypoints for the extension scaffold.
 *
 * These are intentionally non-functional placeholders; command handlers will
 * wire actual search/open behavior in follow-up tasks.
 */
export function registerPromptHistoryCommands(_pi: ExtensionAPI): void {
	// Placeholder registration hook kept intentionally empty for now.
}

export function buildPromptHistorySelectionPayload(
	scope: SearchScope,
	query: string,
): { scope: SearchScope; query: string } {
	return { scope, query };
}

export function isPromptHistoryScope(value: unknown): value is SearchScope {
	return value === "local" || value === "global";
}
