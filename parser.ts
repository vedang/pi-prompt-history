/**
 * Session parsing helpers for prompt-history indexing.
 */
import type { PromptHistoryEntry } from "./db";

export type ParsedSessionPrompt = PromptHistoryEntry;

export interface ParsedSession {
	file: string;
	cwd: string;
	prompts: ParsedSessionPrompt[];
}

export interface ParserOptions {
	cwd?: string;
}

export async function parseSessionFile(
	sessionFile: string,
	options: ParserOptions = {},
): Promise<ParsedSession | null> {
	return {
		file: sessionFile,
		cwd: options.cwd ?? "",
		prompts: [],
	};
}
