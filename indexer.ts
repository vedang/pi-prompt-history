import { statSync } from "node:fs";

import type { ParsedSession, ParsedSessionPrompt } from "./parser";
import { parseSessionFile } from "./parser";
import type { PromptHistoryDb } from "./db";

export type IndexerAction = "created" | "updated" | "rebuilt" | "skipped";

export interface IndexerResult {
	action: IndexerAction;
	indexedPrompts: number;
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
	};
}

export async function indexSessionFile(
	db: PromptHistoryDb,
	sessionFile: string,
): Promise<IndexerResult> {
	const existingSession = db.getIndexedSession(sessionFile);
	const fileStats = statSessionFile(sessionFile);

	if (fileStats === null) {
		db.clearSessionPrompts(sessionFile);
		if (existingSession) {
			db.upsertSession({
				sessionFile,
				cwd: existingSession.cwd,
				sessionName: existingSession.sessionName,
				indexedMtimeMs: 0,
				indexedSizeBytes: 0,
				indexedPromptCount: 0,
				lastIndexedAtMs: Date.now(),
			});
		}

		return {
			action: "skipped",
			indexedPrompts: 0,
		};
	}

	const parsedSession = await parseSessionFile(sessionFile);
	if (parsedSession === null) {
		return {
			action: "skipped",
			indexedPrompts: 0,
		};
	}

	if (
		existingSession &&
		existingSession.indexedSizeBytes === fileStats.size &&
		existingSession.indexedMtimeMs === fileStats.mtimeMs
	) {
		return {
			action: "skipped",
			indexedPrompts: 0,
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
		const indexedPrompts = indexPrompts(
			db,
			parsedSession.prompts,
			parsedSession.sessionName,
		);

		return {
			action: "created",
			indexedPrompts,
		};
	}

	const shouldRebuild = fileStats.size < existingSession.indexedSizeBytes;
	if (shouldRebuild) {
		db.clearSessionPrompts(sessionFile);
		const indexedPrompts = indexPrompts(
			db,
			parsedSession.prompts,
			parsedSession.sessionName,
		);

		return {
			action: "rebuilt",
			indexedPrompts,
		};
	}

	const indexedPrompts = indexPrompts(
		db,
		parsedSession.prompts,
		parsedSession.sessionName,
	);

	return {
		action: "updated",
		indexedPrompts,
	};
}

const indexPrompts = (
	db: PromptHistoryDb,
	prompts: ParsedSessionPrompt[],
	sessionName: string,
): number =>
	prompts.reduce((total, prompt) => {
		return (
			total +
			db.insertPrompt(
				{
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
				},
				Date.now(),
			)
		);
	}, 0);

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
