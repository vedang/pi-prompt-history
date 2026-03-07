import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { IndexedSessionMetadata, PromptHistoryDb } from "./db";
import type { ParsedSession, ParsedSessionPrompt } from "./parser";
import { parseSessionFile } from "./parser";

export type IndexerAction = "created" | "updated" | "rebuilt" | "skipped";

export interface IndexerResult {
	action: IndexerAction;
	indexedPrompts: number;
	sessionFile?: string;
}

export interface IndexSessionFileOptions {
	forceRebuild?: boolean;
}

interface SessionFileStats {
	size: number;
	mtimeMs: number;
}

export async function indexSession(
	db: PromptHistoryDb,
	session: ParsedSession,
): Promise<IndexerResult> {
	const indexedAtMs = Date.now();
	db.upsertSession({
		sessionFile: session.file,
		cwd: session.cwd,
		sessionName: session.sessionName,
		indexedMtimeMs: 0,
		indexedSizeBytes: 0,
		indexedPromptCount: session.prompts.length,
		lastIndexedAtMs: indexedAtMs,
	});

	const indexedPrompts = indexPrompts(
		db,
		session.prompts,
		session.sessionName,
		indexedAtMs,
	);
	return createIndexerResult(
		indexedPrompts > 0 ? "updated" : "skipped",
		indexedPrompts,
		session.file,
	);
}

export async function indexSessionFile(
	db: PromptHistoryDb,
	sessionFile: string,
	options: IndexSessionFileOptions = {},
): Promise<IndexerResult> {
	const existingSession = db.getIndexedSession(sessionFile);
	const fileStats = statSessionFile(sessionFile);

	if (fileStats === null) {
		db.clearSessionPrompts(sessionFile);
		return createIndexerResult("skipped", 0, sessionFile);
	}

	if (
		isSessionFileUnchanged(existingSession, fileStats, options.forceRebuild)
	) {
		return createIndexerResult("skipped", 0, sessionFile);
	}

	const parsedSession = await parseSessionFile(sessionFile);
	if (parsedSession === null) {
		return createIndexerResult("skipped", 0, sessionFile);
	}

	const indexedAtMs = Date.now();
	db.upsertSession({
		sessionFile,
		cwd: parsedSession.cwd,
		sessionName: parsedSession.sessionName,
		indexedMtimeMs: fileStats.mtimeMs,
		indexedSizeBytes: fileStats.size,
		indexedPromptCount: parsedSession.prompts.length,
		lastIndexedAtMs: indexedAtMs,
	});

	const action = getIndexAction(
		existingSession,
		fileStats,
		options.forceRebuild,
	);
	if (action === "rebuilt") {
		db.clearSessionPrompts(sessionFile);
	}

	const indexedPrompts = indexPrompts(
		db,
		parsedSession.prompts,
		parsedSession.sessionName,
		indexedAtMs,
	);
	return createIndexerResult(action, indexedPrompts, sessionFile);
}

export async function indexSessionFiles(
	db: PromptHistoryDb,
	sessionFiles: string[],
	options: IndexSessionFileOptions = {},
): Promise<IndexerResult[]> {
	const results: IndexerResult[] = [];
	for (const sessionFile of sessionFiles) {
		results.push(await indexSessionFile(db, sessionFile, options));
	}
	return results;
}

export function discoverSessionFiles(sessionDir: string): string[] {
	const results: string[] = [];
	for (const entry of walkEntries(sessionDir)) {
		if (entry.endsWith(".jsonl")) {
			results.push(entry);
		}
	}
	return results.sort();
}

export function filterSessionFilesByCwd(
	sessionFiles: string[],
	cwd: string,
): string[] {
	return sessionFiles.filter((sessionFile) => {
		return readSessionHeaderCwd(sessionFile) === cwd;
	});
}

const walkEntries = (rootDir: string): string[] => {
	try {
		const entries = readdirSync(rootDir, { withFileTypes: true });
		return entries.flatMap((entry) => {
			const path = join(rootDir, entry.name);
			if (entry.isDirectory()) {
				return walkEntries(path);
			}
			return [path];
		});
	} catch {
		return [];
	}
};

const readSessionHeaderCwd = (sessionFile: string): string | undefined => {
	try {
		const firstLine = readFileSync(sessionFile, "utf-8")
			.split("\n", 1)[0]
			?.trim();
		if (!firstLine) {
			return undefined;
		}
		const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
		if (header.type !== "session" || typeof header.cwd !== "string") {
			return undefined;
		}
		return header.cwd;
	} catch {
		return undefined;
	}
};

const createIndexerResult = (
	action: IndexerAction,
	indexedPrompts: number,
	sessionFile: string,
): IndexerResult => ({
	action,
	indexedPrompts,
	sessionFile,
});

const isSessionFileUnchanged = (
	existingSession: IndexedSessionMetadata | null,
	fileStats: SessionFileStats,
	forceRebuild = false,
): boolean => {
	return Boolean(
		!forceRebuild &&
			existingSession &&
			existingSession.indexedSizeBytes === fileStats.size &&
			existingSession.indexedMtimeMs === fileStats.mtimeMs,
	);
};

const shouldRebuildSessionFile = (
	existingSession: IndexedSessionMetadata,
	fileStats: SessionFileStats,
	forceRebuild = false,
): boolean => {
	return forceRebuild || fileStats.size < existingSession.indexedSizeBytes;
};

const getIndexAction = (
	existingSession: IndexedSessionMetadata | null,
	fileStats: SessionFileStats,
	forceRebuild = false,
): Exclude<IndexerAction, "skipped"> => {
	if (existingSession === null) {
		return "created";
	}

	return shouldRebuildSessionFile(existingSession, fileStats, forceRebuild)
		? "rebuilt"
		: "updated";
};

const indexPrompts = (
	db: PromptHistoryDb,
	prompts: ParsedSessionPrompt[],
	sessionName: string,
	indexedAtMs: number,
): number =>
	db.insertPrompts(
		prompts.map((prompt) => ({
			sessionFile: prompt.sessionFile,
			entryId: prompt.entryId,
			parentId: prompt.parentId,
			sessionName,
			cwd: prompt.cwd,
			promptTimestampMs: prompt.promptTimestampMs,
			ordinalInSession: prompt.ordinalInSession,
			text: prompt.text,
			preview: prompt.preview,
			contentHash: prompt.contentHash,
		})),
		indexedAtMs,
	);

const normalizeIndexedMtimeMs = (mtimeMs: number): number => {
	return Math.trunc(mtimeMs);
};

const statSessionFile = (path: string): SessionFileStats | null => {
	try {
		const stats = statSync(path);
		return {
			size: stats.size,
			mtimeMs: normalizeIndexedMtimeMs(stats.mtimeMs),
		};
	} catch {
		return null;
	}
};
