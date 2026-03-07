import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildPromptPreview,
	extractUserPromptText,
	parseSessionFile,
	type ParsedSessionPrompt,
} from "../parser";

test("extractUserPromptText returns string content directly", () => {
	assert.equal(extractUserPromptText("hello world"), "hello world");
});

test("extractUserPromptText joins only text blocks from mixed content arrays", () => {
	const content = [
		{ type: "text", text: "first line" },
		{ type: "image", data: "...", mimeType: "image/png" },
		{ type: "text", text: "second line" },
	];

	assert.equal(extractUserPromptText(content), "first line\nsecond line");
});

test("extractUserPromptText ignores non-text and blank content", () => {
	assert.equal(
		extractUserPromptText([{ type: "image", data: "..." }]),
		undefined,
	);
	assert.equal(extractUserPromptText("   \n\t  "), undefined);
});

test("buildPromptPreview trims and collapses whitespace for list rendering", () => {
	assert.equal(buildPromptPreview("  hello\n\n   world   "), "hello world");
});

test("parseSessionFile extracts user prompts, cwd, and latest session name", async () => {
	const dir = mkdtempSync(join(tmpdir(), "prompt-history-parser-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(
		sessionFile,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2026-03-07T00:00:00.000Z",
				cwd: "/tmp/project-a",
			}),
			JSON.stringify({
				type: "session_info",
				id: "info-1",
				parentId: null,
				timestamp: "2026-03-07T00:00:01.000Z",
				name: "First Name",
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-03-07T00:00:02.000Z",
				message: {
					role: "user",
					content: "Find TODO mentions",
					timestamp: 100,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-03-07T00:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I can help." }],
					timestamp: 200,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: "2026-03-07T00:00:04.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "line 1" },
						{ type: "image", data: "...", mimeType: "image/png" },
						{ type: "text", text: "line 2" },
					],
					timestamp: 300,
				},
			}),
			JSON.stringify({
				type: "custom_message",
				id: "cm1",
				parentId: "m3",
				timestamp: "2026-03-07T00:00:05.000Z",
				customType: "x",
				content: "ignored",
				display: true,
			}),
			JSON.stringify({
				type: "session_info",
				id: "info-2",
				parentId: "m3",
				timestamp: "2026-03-07T00:00:06.000Z",
				name: "Renamed Session",
			}),
		].join("\n") + "\n",
	);

	const parsed = await parseSessionFile(sessionFile);

	assert.ok(parsed);
	assert.equal(parsed?.file, sessionFile);
	assert.equal(parsed?.cwd, "/tmp/project-a");
	assert.equal(parsed?.sessionName, "Renamed Session");
	assert.equal(parsed?.prompts.length, 2);

	assert.deepEqual(
		parsed?.prompts.map((prompt: ParsedSessionPrompt) => ({
			entryId: prompt.entryId,
			parentId: prompt.parentId,
			cwd: prompt.cwd,
			sessionName: prompt.sessionName,
			text: prompt.text,
			preview: prompt.preview,
			ordinalInSession: prompt.ordinalInSession,
			promptTimestampMs: prompt.promptTimestampMs,
		})),
		[
			{
				entryId: "m1",
				parentId: null,
				cwd: "/tmp/project-a",
				sessionName: "Renamed Session",
				text: "Find TODO mentions",
				preview: "Find TODO mentions",
				ordinalInSession: 0,
				promptTimestampMs: 100,
			},
			{
				entryId: "m3",
				parentId: "m2",
				cwd: "/tmp/project-a",
				sessionName: "Renamed Session",
				text: "line 1\nline 2",
				preview: "line 1 line 2",
				ordinalInSession: 1,
				promptTimestampMs: 300,
			},
		],
	);

	assert.match(parsed?.prompts[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);
	assert.notEqual(
		parsed?.prompts[0]?.contentHash,
		parsed?.prompts[1]?.contentHash,
	);
});

test("parseSessionFile falls back to entry timestamp when message timestamp is missing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "prompt-history-parser-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(
		sessionFile,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2026-03-07T00:00:00.000Z",
				cwd: "/tmp/project-b",
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-03-07T00:00:02.500Z",
				message: {
					role: "user",
					content: "fallback timestamp",
				},
			}),
		].join("\n") + "\n",
	);

	const parsed = await parseSessionFile(sessionFile);
	assert.equal(
		parsed?.prompts[0]?.promptTimestampMs,
		Date.parse("2026-03-07T00:00:02.500Z"),
	);
});
