import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { PromptHistoryDb } from "./db";
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

export async function indexSession(
	db: PromptHistoryDb,
	session: ParsedSession,
): Promise<IndexerResult> {
	const indexedPrompts = indexPrompts(db, session.prompts, session.sessionName);

	db.upsertSession({
		sessionFile: session.file,
		cwd: session.cwd,
		sessionName: session.sessionName,
		indexedMtimeMs: 0,
		indexedSizeBytes: 0,
		indexedPromptCount: session.prompts.length,
		lastIndexedAtMs: Date.now(),
	});

	return {
		action: indexedPrompts > 0 ? "updated" : "skipped",
		indexedPrompts,
		sessionFile: session.file,
	};
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
		return {
			action: "skipped",
			indexedPrompts: 0,
			sessionFile,
		};
	}

	if (
		!options.forceRebuild &&
		existingSession &&
		existingSession.indexedSizeBytes === fileStats.size &&
		existingSession.indexedMtimeMs === fileStats.mtimeMs
	) {
		return {
			action: "skipped",
			indexedPrompts: 0,
			sessionFile,
		};
	}

	const parsedSession = await parseSessionFile(sessionFile);
	if (parsedSession === null) {
		return {
			action: "skipped",
			indexedPrompts: 0,
			sessionFile,
		};
	}

	db.upsertSession({
		sessionFile,
		cwd: parsedSession.cwd,
		sessionName: parsedSession.sessionName,
		indexedMtimeMs: fileStats.mtimeMs,
		indexedSizeBytes: fileStats.size,
		indexedPromptCount: parsedSession.prompts.length,
		lastIndexedAtMs: Date.now(),
	});

	if (!existingSession) {
		return {
			action: "created",
			indexedPrompts: indexPrompts(
				db,
				parsedSession.prompts,
				parsedSession.sessionName,
			),
			sessionFile,
		};
	}

	const shouldRebuild =
		options.forceRebuild || fileStats.size < existingSession.indexedSizeBytes;
	if (shouldRebuild) {
		db.clearSessionPrompts(sessionFile);
		return {
			action: "rebuilt",
			indexedPrompts: indexPrompts(
				db,
				parsedSession.prompts,
				parsedSession.sessionName,
			),
			sessionFile,
		};
	}

	return {
		action: "updated",
		indexedPrompts: indexPrompts(
			db,
			parsedSession.prompts,
			parsedSession.sessionName,
		),
		sessionFile,
	};
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

const indexPrompts = (
	db: PromptHistoryDb,
	prompts: ParsedSessionPrompt[],
	sessionName: string,
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
		Date.now(),
	);

const statSessionFile = (
	path: string,
): { size: number; mtimeMs: number } | null => {
	try {
		const stats = statSync(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs };
	} catch {
		return null;
	}
};
