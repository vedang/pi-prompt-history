import assert from "node:assert/strict";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PromptHistoryDb } from "../db";
import { indexSessionFile } from "../indexer";

const TEST_MTIME_MS = {
	initial: 1_700_000_000_123.456,
	updated: 1_700_000_000_987.654,
	rebuilt: 1_700_000_001_234.567,
} as const;

const createTempDir = () =>
	mkdtempSync(join(tmpdir(), "prompt-history-indexer-"));

const sessionHeader = (cwd: string) =>
	JSON.stringify({
		type: "session",
		version: 3,
		id: `${cwd}-session`,
		timestamp: "2026-03-07T00:00:00.000Z",
		cwd,
	});

const sessionInfo = (name: string, parentId: string | null = null) =>
	JSON.stringify({
		type: "session_info",
		id: `${name}-info`,
		parentId,
		timestamp: "2026-03-07T00:00:01.000Z",
		name,
	});

const userMessage = (
	id: string,
	parentId: string | null,
	timestamp: string,
	content: string,
	messageTimestampMs: number,
) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "user",
			content,
			timestamp: messageTimestampMs,
		},
	});

const assistantMessage = (
	id: string,
	parentId: string,
	timestamp: string,
	text: string,
) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: Date.parse(timestamp),
		},
	});

const writeSession = (sessionFile: string, lines: string[]) => {
	writeFileSync(sessionFile, lines.join("\n") + "\n");
};

const setSessionMtime = (sessionFile: string, mtimeMs: number) => {
	utimesSync(sessionFile, mtimeMs / 1_000, mtimeMs / 1_000);
};

const listGlobalPromptTexts = (db: PromptHistoryDb, cwd: string): string[] => {
	return db
		.listRecentPrompts({ scope: "global", cwd, limit: 10 })
		.map((entry) => entry.text);
};

test("indexSessionFile backfills sessions and exposes recent prompts", async () => {
	const dir = createTempDir();
	const db = new PromptHistoryDb({ path: join(dir, "history.db") });
	const sessionFile = join(dir, "session-a.jsonl");

	writeSession(sessionFile, [
		sessionHeader("/tmp/project-a"),
		sessionInfo("Alpha Session"),
		userMessage("m1", null, "2026-03-07T00:00:02.000Z", "first prompt", 100),
		assistantMessage("m2", "m1", "2026-03-07T00:00:03.000Z", "reply"),
		userMessage("m3", "m2", "2026-03-07T00:00:04.000Z", "second prompt", 200),
	]);

	const result = await indexSessionFile(db, sessionFile);
	assert.equal(result.action, "created");
	assert.equal(result.indexedPrompts, 2);

	const indexedSession = db.getIndexedSession(sessionFile);
	assert.equal(indexedSession?.cwd, "/tmp/project-a");
	assert.equal(indexedSession?.sessionName, "Alpha Session");

	const localRecents = db.listRecentPrompts({
		scope: "local",
		cwd: "/tmp/project-a",
		limit: 10,
	});
	assert.deepEqual(
		localRecents.map((entry) => entry.text),
		["second prompt", "first prompt"],
	);

	db.close();
});

test("indexSessionFile skips unchanged files, appends on growth, and rebuilds on shrink", async () => {
	const dir = createTempDir();
	const db = new PromptHistoryDb({ path: join(dir, "history.db") });
	const sessionFile = join(dir, "session-b.jsonl");

	const initialLines = [
		sessionHeader("/tmp/project-b"),
		sessionInfo("Beta Session"),
		userMessage("m1", null, "2026-03-07T00:00:02.000Z", "one", 100),
		assistantMessage("m2", "m1", "2026-03-07T00:00:03.000Z", "reply"),
		userMessage("m3", "m2", "2026-03-07T00:00:04.000Z", "two", 200),
	];
	writeSession(sessionFile, initialLines);
	setSessionMtime(sessionFile, TEST_MTIME_MS.initial);

	await indexSessionFile(db, sessionFile);
	const indexedSession = db.getIndexedSession(sessionFile);
	assert.equal(
		indexedSession?.indexedMtimeMs,
		Math.trunc(statSync(sessionFile).mtimeMs),
	);

	const skipped = await indexSessionFile(db, sessionFile);
	assert.equal(skipped.action, "skipped");
	assert.equal(listGlobalPromptTexts(db, "/tmp/project-b").length, 2);

	writeSession(sessionFile, [
		...initialLines,
		assistantMessage("m4", "m3", "2026-03-07T00:00:05.000Z", "another reply"),
		userMessage("m5", "m4", "2026-03-07T00:00:06.000Z", "three", 300),
	]);
	setSessionMtime(sessionFile, TEST_MTIME_MS.updated);
	const updated = await indexSessionFile(db, sessionFile);
	assert.equal(updated.action, "updated");
	assert.equal(updated.indexedPrompts, 1);
	assert.deepEqual(listGlobalPromptTexts(db, "/tmp/project-b"), [
		"three",
		"two",
		"one",
	]);

	writeSession(sessionFile, [
		sessionHeader("/tmp/project-b"),
		sessionInfo("Beta Session"),
		userMessage("m1", null, "2026-03-07T00:00:02.000Z", "one", 100),
	]);
	setSessionMtime(sessionFile, TEST_MTIME_MS.rebuilt);
	const rebuilt = await indexSessionFile(db, sessionFile);
	assert.equal(rebuilt.action, "rebuilt");
	assert.equal(rebuilt.indexedPrompts, 1);
	assert.deepEqual(listGlobalPromptTexts(db, "/tmp/project-b"), ["one"]);

	db.close();
});
