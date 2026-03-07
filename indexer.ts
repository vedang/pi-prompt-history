import type { PromptHistoryDb } from "./db";
import type { ParsedSession } from "./parser";

/**
 * Placeholder indexer entrypoints for future incremental indexing work.
 */
export async function indexSession(
	db: PromptHistoryDb,
	session: ParsedSession,
): Promise<number> {
	db;
	session;
	return 0;
}

export async function indexSessionFile(
	db: PromptHistoryDb,
	sessionFile: string,
): Promise<number> {
	db;
	return indexSessionFileInternal(sessionFile);
}

async function indexSessionFileInternal(sessionFile: string): Promise<number> {
	sessionFile;
	return 0;
}
