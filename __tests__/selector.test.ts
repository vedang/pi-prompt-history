import assert from "node:assert/strict";
import test from "node:test";

import {
	buildPromptHistoryMetadata,
	formatRelativeTime,
	togglePromptHistoryScope,
} from "../selector";

test("togglePromptHistoryScope switches between local and global", () => {
	assert.equal(togglePromptHistoryScope("local"), "global");
	assert.equal(togglePromptHistoryScope("global"), "local");
});

test("formatRelativeTime produces compact relative labels", () => {
	const now = Date.parse("2026-03-07T10:00:00.000Z");
	assert.equal(formatRelativeTime(now - 30_000, now), "just now");
	assert.equal(formatRelativeTime(now - 60_000, now), "1m ago");
	assert.equal(formatRelativeTime(now - 2 * 60 * 60_000, now), "2h ago");
	assert.equal(formatRelativeTime(now - 3 * 24 * 60 * 60_000, now), "3d ago");
});

test("buildPromptHistoryMetadata shows session name and cwd in global mode", () => {
	const now = Date.parse("2026-03-07T10:00:00.000Z");
	const metadata = buildPromptHistoryMetadata(
		{
			sessionFile: "/tmp/sessions/session-a.jsonl",
			sessionName: "Alpha Session",
			cwd: "/tmp/project-a",
			timestampMs: now - 60_000,
		},
		"global",
		now,
	);

	assert.match(metadata, /1m ago/);
	assert.match(metadata, /Alpha Session/);
	assert.match(metadata, /\/tmp\/project-a/);
});

test("buildPromptHistoryMetadata falls back to session file name when no session name exists", () => {
	const now = Date.parse("2026-03-07T10:00:00.000Z");
	const metadata = buildPromptHistoryMetadata(
		{
			sessionFile: "/tmp/sessions/session-b.jsonl",
			sessionName: "",
			cwd: "/tmp/project-b",
			timestampMs: now - 5 * 60_000,
		},
		"local",
		now,
	);

	assert.match(metadata, /5m ago/);
	assert.match(metadata, /session-b\.jsonl/);
	assert.doesNotMatch(metadata, /\/tmp\/project-b/);
});
