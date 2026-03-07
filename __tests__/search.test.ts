import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PromptHistoryDb } from "../db";
import { indexSessionFile } from "../indexer";
import { searchPrompts } from "../search";

const createTempDir = () =>
	mkdtempSync(join(tmpdir(), "prompt-history-search-"));

const sessionHeader = (cwd: string) =>
	JSON.stringify({
		type: "session",
		version: 3,
		id: `${cwd}-session`,
		timestamp: "2026-03-07T00:00:00.000Z",
		cwd,
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

const writeSession = (sessionFile: string, lines: string[]) => {
	writeFileSync(sessionFile, lines.join("\n") + "\n");
};

test("searchPrompts returns most recent prompts for empty local and global queries", async () => {
	const dir = createTempDir();
	const db = new PromptHistoryDb({ path: join(dir, "history.db") });
	const sessionA = join(dir, "session-a.jsonl");
	const sessionB = join(dir, "session-b.jsonl");

	writeSession(sessionA, [
		sessionHeader("/tmp/project-a"),
		userMessage("a1", null, "2026-03-07T00:00:01.000Z", "alpha local", 100),
		userMessage("a2", "a1", "2026-03-07T00:00:02.000Z", "beta local", 200),
	]);
	writeSession(sessionB, [
		sessionHeader("/tmp/project-b"),
		userMessage("b1", null, "2026-03-07T00:00:03.000Z", "gamma global", 300),
	]);

	await indexSessionFile(db, sessionA);
	await indexSessionFile(db, sessionB);

	const localResults = await searchPrompts(db, {
		scope: "local",
		cwd: "/tmp/project-a",
		query: "",
		limit: 10,
	});
	assert.deepEqual(
		localResults.map((entry) => entry.text),
		["beta local", "alpha local"],
	);

	const globalResults = await searchPrompts(db, {
		scope: "global",
		cwd: "/tmp/project-a",
		query: "",
		limit: 10,
	});
	assert.deepEqual(
		globalResults.map((entry) => entry.text),
		["gamma global", "beta local", "alpha local"],
	);

	db.close();
});

test("searchPrompts boosts exact substring matches over weaker fuzzy matches", async () => {
	const dir = createTempDir();
	const db = new PromptHistoryDb({ path: join(dir, "history.db") });
	const sessionFile = join(dir, "session.jsonl");

	writeSession(sessionFile, [
		sessionHeader("/tmp/project-c"),
		userMessage("m1", null, "2026-03-07T00:00:01.000Z", "alpha roadmap", 100),
		userMessage(
			"m2",
			"m1",
			"2026-03-07T00:00:02.000Z",
			"a long phase around",
			200,
		),
	]);

	await indexSessionFile(db, sessionFile);

	const results = await searchPrompts(db, {
		scope: "local",
		cwd: "/tmp/project-c",
		query: "alpha",
		limit: 10,
	});

	assert.deepEqual(
		results.map((entry) => entry.text),
		["alpha roadmap", "a long phase around"],
	);
	assert.deepEqual(results[0]?.matchPositions, [0, 1, 2, 3, 4]);
	assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));

	db.close();
});

test("searchPrompts respects local scope when filtering results", async () => {
	const dir = createTempDir();
	const db = new PromptHistoryDb({ path: join(dir, "history.db") });
	const sessionA = join(dir, "session-a.jsonl");
	const sessionB = join(dir, "session-b.jsonl");

	writeSession(sessionA, [
		sessionHeader("/tmp/project-a"),
		userMessage(
			"a1",
			null,
			"2026-03-07T00:00:01.000Z",
			"todo search local",
			100,
		),
	]);
	writeSession(sessionB, [
		sessionHeader("/tmp/project-b"),
		userMessage(
			"b1",
			null,
			"2026-03-07T00:00:02.000Z",
			"todo search global",
			200,
		),
	]);

	await indexSessionFile(db, sessionA);
	await indexSessionFile(db, sessionB);

	const localResults = await searchPrompts(db, {
		scope: "local",
		cwd: "/tmp/project-a",
		query: "todo",
		limit: 10,
	});
	assert.deepEqual(
		localResults.map((entry) => entry.cwd),
		["/tmp/project-a"],
	);
	assert.deepEqual(
		localResults.map((entry) => entry.text),
		["todo search local"],
	);

	const globalResults = await searchPrompts(db, {
		scope: "global",
		cwd: "/tmp/project-a",
		query: "todo",
		limit: 10,
	});
	assert.deepEqual(
		globalResults.map((entry) => entry.text),
		["todo search global", "todo search local"],
	);

	db.close();
});
