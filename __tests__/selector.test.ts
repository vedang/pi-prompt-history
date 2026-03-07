import assert from "node:assert/strict";
import test from "node:test";

import {
	buildPromptHistoryMetadata,
	formatPromptHistoryScopeLabel,
	formatRelativeTime,
	groupPromptHistoryResults,
	resolvePromptHistoryActionKeyBindings,
	resolvePromptHistorySessionGroup,
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

test("resolvePromptHistorySessionGroup distinguishes current, same-cwd, and other-cwd results", () => {
	assert.equal(
		resolvePromptHistorySessionGroup(
			{ sessionFile: "/tmp/sessions/current.jsonl", cwd: "/tmp/project-a" },
			{
				currentCwd: "/tmp/project-a",
				activeSessionFile: "/tmp/sessions/current.jsonl",
			},
		),
		"current-session",
	);
	assert.equal(
		resolvePromptHistorySessionGroup(
			{ sessionFile: "/tmp/sessions/other.jsonl", cwd: "/tmp/project-a" },
			{
				currentCwd: "/tmp/project-a",
				activeSessionFile: "/tmp/sessions/current.jsonl",
			},
		),
		"same-cwd",
	);
	assert.equal(
		resolvePromptHistorySessionGroup(
			{ sessionFile: "/tmp/sessions/external.jsonl", cwd: "/tmp/project-b" },
			{
				currentCwd: "/tmp/project-a",
				activeSessionFile: "/tmp/sessions/current.jsonl",
			},
		),
		"other-cwd",
	);
});

test("groupPromptHistoryResults orders sections as current, same-cwd, then other-cwd", () => {
	const sections = groupPromptHistoryResults(
		[
			{
				id: "external",
				sessionFile: "/tmp/sessions/external.jsonl",
				sessionName: "External",
				preview: "external",
				text: "external",
				cwd: "/tmp/project-b",
				timestampMs: 1,
				score: 1,
				matchPositions: [],
			},
			{
				id: "current",
				sessionFile: "/tmp/sessions/current.jsonl",
				sessionName: "Current",
				preview: "current",
				text: "current",
				cwd: "/tmp/project-a",
				timestampMs: 2,
				score: 2,
				matchPositions: [],
			},
			{
				id: "same-cwd",
				sessionFile: "/tmp/sessions/other.jsonl",
				sessionName: "Same cwd",
				preview: "same cwd",
				text: "same cwd",
				cwd: "/tmp/project-a",
				timestampMs: 3,
				score: 3,
				matchPositions: [],
			},
		],
		{
			currentCwd: "/tmp/project-a",
			activeSessionFile: "/tmp/sessions/current.jsonl",
		},
	);

	assert.deepEqual(
		sections.map((section) => section.group),
		["current-session", "same-cwd", "other-cwd"],
	);
	assert.deepEqual(
		sections.flatMap((section) => section.results.map((result) => result.id)),
		["current", "same-cwd", "external"],
	);
});

test("buildPromptHistoryMetadata shows other-cwd metadata in global mode", () => {
	const now = Date.parse("2026-03-07T10:00:00.000Z");
	const metadata = buildPromptHistoryMetadata(
		{
			sessionFile: "/tmp/sessions/session-a.jsonl",
			sessionName: "Alpha Session",
			cwd: "/tmp/project-a",
			timestampMs: now - 60_000,
		},
		{
			scope: "global",
			nowMs: now,
			sessionGroup: "other-cwd",
			currentCwd: "/tmp/project-b",
		},
	);

	assert.match(metadata, /1m ago/);
	assert.match(metadata, /Alpha Session/);
	assert.match(metadata, /other cwd/);
	assert.match(metadata, /\/tmp\/project-a/);
});

test("buildPromptHistoryMetadata falls back to session file name and marks current session in local mode", () => {
	const now = Date.parse("2026-03-07T10:00:00.000Z");
	const metadata = buildPromptHistoryMetadata(
		{
			sessionFile: "/tmp/sessions/session-b.jsonl",
			sessionName: "",
			cwd: "/tmp/project-b",
			timestampMs: now - 5 * 60_000,
		},
		{
			scope: "local",
			nowMs: now,
			sessionGroup: "current-session",
			currentCwd: "/tmp/project-b",
		},
	);

	assert.match(metadata, /5m ago/);
	assert.match(metadata, /session-b\.jsonl/);
	assert.match(metadata, /current session/);
	assert.doesNotMatch(metadata, /\/tmp\/project-b/);
});

test("formatPromptHistoryScopeLabel distinguishes current, same-cwd, and other-cwd groups", () => {
	assert.equal(
		formatPromptHistoryScopeLabel("local", "current-session"),
		"Local • Current session",
	);
	assert.equal(
		formatPromptHistoryScopeLabel("local", "same-cwd"),
		"Local • Same cwd",
	);
	assert.equal(
		formatPromptHistoryScopeLabel("global", "other-cwd"),
		"Global • Other cwd",
	);
});

test("resolvePromptHistoryActionKeyBindings makes copy primary by default", () => {
	assert.deepEqual(resolvePromptHistoryActionKeyBindings("copy"), {
		copy: "enter",
		resume: "f2",
	});
});

test("resolvePromptHistoryActionKeyBindings can make resume primary", () => {
	assert.deepEqual(resolvePromptHistoryActionKeyBindings("resume"), {
		copy: "f2",
		resume: "enter",
	});
});
