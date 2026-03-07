import assert from "node:assert/strict";
import test from "node:test";

import promptHistoryExtension from "../index";
import {
	handlePromptHistorySelection,
	openPromptHistory,
	PROMPT_HISTORY_RESUME_CHOICES,
	registerPromptHistoryCommands,
} from "../commands";
import type { PromptHistorySelection } from "../selector-ui";

function createSelection(
	overrides: Partial<PromptHistorySelection> = {},
): PromptHistorySelection {
	return {
		action: "copy",
		query: "fix the",
		scope: "local",
		item: {
			id: "entry-1",
			sessionFile: "/tmp/sessions/session-a.jsonl",
			sessionName: "Alpha Session",
			preview: "fix the prompt",
			text: "fix the prompt",
			cwd: "/tmp/project-a",
			timestampMs: 123,
			score: 99,
			matchPositions: [0, 1, 2],
		},
		...overrides,
	};
}

function createTheme(): {
	fg: (_name: string, text: string) => string;
	bold: (text: string) => string;
} {
	return {
		fg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	};
}

class NoopPromptHistorySelector {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

function decodeResumeCommandPayload(command: string): unknown {
	return JSON.parse(
		Buffer.from(
			command.replace(/^\/prompt-history-resume /, ""),
			"base64url",
		).toString("utf8"),
	);
}

test("registerPromptHistoryCommands registers commands and ctrl+r shortcut", () => {
	const commands = new Map<string, { description?: string }>();
	const shortcuts = new Map<string, { description?: string }>();

	const pi = {
		registerCommand(name: string, options: { description?: string }) {
			commands.set(name, options);
		},
		registerShortcut(name: string, options: { description?: string }) {
			shortcuts.set(name, options);
		},
	};

	registerPromptHistoryCommands(pi as never);

	assert.deepEqual([...commands.keys()].sort(), [
		"prompt-history",
		"prompt-history-global",
		"prompt-history-reindex",
		"prompt-history-resume",
		"prompt-history-status",
	]);
	assert.equal(shortcuts.has("ctrl+r"), true);
});

test("promptHistoryExtension wires prompt-history registration through the extension entrypoint", () => {
	const commands = new Map<string, { description?: string }>();
	const shortcuts = new Map<string, { description?: string }>();

	const pi = {
		registerCommand(name: string, options: { description?: string }) {
			commands.set(name, options);
		},
		registerShortcut(name: string, options: { description?: string }) {
			shortcuts.set(name, options);
		},
	};

	promptHistoryExtension(pi as never);

	assert.equal(commands.has("prompt-history"), true);
	assert.equal(commands.has("prompt-history-global"), true);
	assert.equal(commands.has("prompt-history-reindex"), true);
	assert.equal(commands.has("prompt-history-status"), true);
	assert.equal(shortcuts.has("ctrl+r"), true);
});

test("openPromptHistory seeds the initial query from the current editor text", async () => {
	const searchCalls: Array<{
		query: string;
		scope: string;
		cwd: string;
		limit?: number;
	}> = [];
	let selectorOptions:
		| {
				initialQuery?: string;
				primaryAction?: string;
		  }
		| undefined;

	class RecordingPromptHistorySelector extends NoopPromptHistorySelector {
		constructor(options: { initialQuery?: string; primaryAction?: string }) {
			super();
			selectorOptions = options;
		}
	}

	const ctx = {
		hasUI: true,
		cwd: "/tmp/project-a",
		sessionManager: {
			getSessionFile: () => undefined,
		},
		ui: {
			getEditorText: () => "fix the",
			custom: async (
				factory: (
					tui: { requestRender: () => void },
					theme: ReturnType<typeof createTheme>,
					keybindings: unknown,
					done: (result: unknown) => void,
				) => unknown,
			) => {
				await factory({ requestRender: () => {} }, createTheme(), {}, () => {});
				return null;
			},
			notify: () => {},
			setEditorText: () => {},
		},
	};

	await openPromptHistory(ctx as never, "local", {
		resolveConfig: () => ({
			dbPath: "/tmp/history.db",
			sessionDir: "/tmp/sessions",
			maxResults: 20,
			localMode: "cwd",
			primaryAction: "resume",
		}),
		createDb: () => ({
			close() {},
			listRecentPrompts() {
				return [];
			},
		}),
		refreshIndex: async () => [],
		search: async (_db, options) => {
			searchCalls.push(options);
			return [];
		},
		loadSelector: async () => ({
			PromptHistorySelector: RecordingPromptHistorySelector as never,
		}),
	});

	assert.equal(searchCalls[0]?.query, "fix the");
	assert.equal(selectorOptions?.initialQuery, "fix the");
	assert.equal(selectorOptions?.primaryAction, "resume");
});

test("openPromptHistory prefills an internal resume command when session controls are unavailable", async () => {
	const editorTexts: string[] = [];
	const notifications: string[] = [];

	const ctx = {
		hasUI: true,
		cwd: "/tmp/project-a",
		sessionManager: {
			getSessionFile: () => undefined,
		},
		ui: {
			getEditorText: () => "fix the",
			custom: async (
				factory: (
					tui: { requestRender: () => void },
					theme: ReturnType<typeof createTheme>,
					keybindings: unknown,
					done: (result: unknown) => void,
				) => unknown,
			) => {
				await factory({ requestRender: () => {} }, createTheme(), {}, () => {});
				return createSelection({ action: "resume" });
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			setEditorText: (text: string) => {
				editorTexts.push(text);
			},
			select: async () => PROMPT_HISTORY_RESUME_CHOICES.fork,
		},
	};

	await openPromptHistory(ctx as never, "local", {
		resolveConfig: () => ({
			dbPath: "/tmp/history.db",
			sessionDir: "/tmp/sessions",
			maxResults: 20,
			localMode: "cwd",
			primaryAction: "copy",
		}),
		createDb: () => ({
			close() {},
			listRecentPrompts() {
				return [];
			},
		}),
		refreshIndex: async () => [],
		search: async () => [],
		loadSelector: async () => ({
			PromptHistorySelector: NoopPromptHistorySelector as never,
		}),
	});

	assert.match(editorTexts[0] ?? "", /^\/prompt-history-resume /);
	assert.match(notifications[0] ?? "", /Press Enter/i);
	assert.deepEqual(decodeResumeCommandPayload(editorTexts[0] ?? ""), {
		mode: "fork",
		entryId: "entry-1",
		scope: "local",
		fallbackText: "fix the prompt",
		sessionFile: "/tmp/sessions/session-a.jsonl",
	});
});

test("openPromptHistory prefills a restore command for global resume when session controls are unavailable", async () => {
	const editorTexts: string[] = [];
	const notifications: string[] = [];
	let selectCalls = 0;

	const ctx = {
		hasUI: true,
		cwd: "/tmp/project-a",
		sessionManager: {
			getSessionFile: () => undefined,
		},
		ui: {
			getEditorText: () => "fix the",
			custom: async (
				factory: (
					tui: { requestRender: () => void },
					theme: ReturnType<typeof createTheme>,
					keybindings: unknown,
					done: (result: unknown) => void,
				) => unknown,
			) => {
				await factory({ requestRender: () => {} }, createTheme(), {}, () => {});
				return createSelection({ action: "resume", scope: "global" });
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			setEditorText: (text: string) => {
				editorTexts.push(text);
			},
			select: async () => {
				selectCalls += 1;
				return PROMPT_HISTORY_RESUME_CHOICES.fork;
			},
		},
	};

	await openPromptHistory(ctx as never, "local", {
		resolveConfig: () => ({
			dbPath: "/tmp/history.db",
			sessionDir: "/tmp/sessions",
			maxResults: 20,
			localMode: "cwd",
			primaryAction: "copy",
		}),
		createDb: () => ({
			close() {},
			listRecentPrompts() {
				return [];
			},
		}),
		refreshIndex: async () => [],
		search: async () => [],
		loadSelector: async () => ({
			PromptHistorySelector: NoopPromptHistorySelector as never,
		}),
	});

	assert.equal(selectCalls, 1);
	assert.match(editorTexts[0] ?? "", /^\/prompt-history-resume /);
	assert.match(notifications[0] ?? "", /Press Enter/i);
	assert.deepEqual(decodeResumeCommandPayload(editorTexts[0] ?? ""), {
		mode: "fork",
		entryId: "entry-1",
		scope: "global",
		fallbackText: "fix the prompt",
		sessionFile: "/tmp/sessions/session-a.jsonl",
	});
});

test("handlePromptHistorySelection copies the selected prompt into the editor and clipboard", async () => {
	const editorTexts: string[] = [];
	const clipboardTexts: string[] = [];
	const notifications: string[] = [];

	const ctx = {
		ui: {
			setEditorText: (text: string) => {
				editorTexts.push(text);
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			select: async () => undefined,
		},
		waitForIdle: async () => {},
		fork: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
	};

	await handlePromptHistorySelection(ctx as never, createSelection(), {
		copyToClipboard: (text: string) => {
			clipboardTexts.push(text);
		},
	});

	assert.deepEqual(editorTexts, ["fix the prompt"]);
	assert.deepEqual(clipboardTexts, ["fix the prompt"]);
	assert.match(notifications[0] ?? "", /Loaded prompt from local history/);
});

test("handlePromptHistorySelection forks from the selected prompt by default when resuming", async () => {
	const operations: string[] = [];
	const selection = createSelection({ action: "resume" });

	const ctx = {
		sessionManager: {
			getSessionFile: () => "/tmp/sessions/session-a.jsonl",
		},
		ui: {
			setEditorText: (text: string) => {
				operations.push(`set:${text}`);
			},
			notify: (message: string) => {
				operations.push(`notify:${message}`);
			},
			select: async () => PROMPT_HISTORY_RESUME_CHOICES.fork,
		},
		waitForIdle: async () => {
			operations.push("wait");
		},
		fork: async (entryId: string) => {
			operations.push(`fork:${entryId}`);
			return {
				cancelled: false,
				selectedText: "fix the prompt",
			};
		},
		switchSession: async (_sessionFile: string) => {
			operations.push("switch");
			return { cancelled: false };
		},
	};

	await handlePromptHistorySelection(ctx as never, selection);

	assert.deepEqual(operations.slice(0, 3), [
		"wait",
		"fork:entry-1",
		"set:fix the prompt",
	]);
	assert.equal(operations.includes("switch"), false);
	assert.match(
		operations.find((entry) => entry.startsWith("notify:")) ?? "",
		/Forked from local history/,
	);
});

test("handlePromptHistorySelection resumes even when waitForIdle is unavailable", async () => {
	const operations: string[] = [];
	const selection = createSelection({ action: "resume" });

	const ctx = {
		sessionManager: {
			getSessionFile: () => "/tmp/sessions/session-a.jsonl",
		},
		ui: {
			setEditorText: (text: string) => {
				operations.push(`set:${text}`);
			},
			notify: (message: string) => {
				operations.push(`notify:${message}`);
			},
			select: async () => PROMPT_HISTORY_RESUME_CHOICES.fork,
		},
		fork: async (entryId: string) => {
			operations.push(`fork:${entryId}`);
			return {
				cancelled: false,
				selectedText: "fix the prompt",
			};
		},
		switchSession: async (_sessionFile: string) => {
			operations.push("switch");
			return { cancelled: false };
		},
	};

	await handlePromptHistorySelection(ctx as never, selection);

	assert.deepEqual(operations.slice(0, 2), [
		"fork:entry-1",
		"set:fix the prompt",
	]);
	assert.equal(operations.includes("switch"), false);
	assert.match(
		operations.find((entry) => entry.startsWith("notify:")) ?? "",
		/Forked from local history/,
	);
});

test("handlePromptHistorySelection can restore the entire session when resuming", async () => {
	const operations: string[] = [];
	const selection = createSelection({ action: "resume" });

	const ctx = {
		ui: {
			setEditorText: (_text: string) => {
				operations.push("set");
			},
			notify: (message: string) => {
				operations.push(`notify:${message}`);
			},
			select: async () => PROMPT_HISTORY_RESUME_CHOICES.restore,
		},
		waitForIdle: async () => {
			operations.push("wait");
		},
		fork: async (_entryId: string) => {
			operations.push("fork");
			return { cancelled: false };
		},
		switchSession: async (sessionFile: string) => {
			operations.push(`switch:${sessionFile}`);
			return { cancelled: false };
		},
	};

	await handlePromptHistorySelection(ctx as never, selection);

	assert.deepEqual(operations.slice(0, 2), [
		"wait",
		"switch:/tmp/sessions/session-a.jsonl",
	]);
	assert.equal(operations.includes("fork"), false);
	assert.equal(operations.includes("set"), false);
	assert.match(
		operations.find((entry) => entry.startsWith("notify:")) ?? "",
		/Restored session from local history/,
	);
});

test("handlePromptHistorySelection offers fork for global selections and switches sessions before forking", async () => {
	const operations: string[] = [];
	const selection = createSelection({ action: "resume", scope: "global" });

	const ctx = {
		sessionManager: {
			getSessionFile: () => "/tmp/sessions/current-session.jsonl",
		},
		ui: {
			setEditorText: (text: string) => {
				operations.push(`set:${text}`);
			},
			notify: (message: string) => {
				operations.push(`notify:${message}`);
			},
			select: async () => {
				operations.push("select");
				return PROMPT_HISTORY_RESUME_CHOICES.fork;
			},
		},
		waitForIdle: async () => {
			operations.push("wait");
		},
		fork: async (entryId: string) => {
			operations.push(`fork:${entryId}`);
			return { cancelled: false, selectedText: "fix the prompt" };
		},
		switchSession: async (sessionFile: string) => {
			operations.push(`switch:${sessionFile}`);
			return { cancelled: false };
		},
	};

	await handlePromptHistorySelection(ctx as never, selection);

	assert.deepEqual(operations.slice(0, 5), [
		"wait",
		"select",
		"switch:/tmp/sessions/session-a.jsonl",
		"fork:entry-1",
		"set:fix the prompt",
	]);
	assert.match(
		operations.find((entry) => entry.startsWith("notify:")) ?? "",
		/Forked from global history/,
	);
});

test("handlePromptHistorySelection forks within the active session without switching", async () => {
	const operations: string[] = [];
	const selection = createSelection({ action: "resume", scope: "local" });

	const ctx = {
		sessionManager: {
			getSessionFile: () => "/tmp/sessions/session-a.jsonl",
		},
		ui: {
			setEditorText: (text: string) => {
				operations.push(`set:${text}`);
			},
			notify: (message: string) => {
				operations.push(`notify:${message}`);
			},
			select: async () => PROMPT_HISTORY_RESUME_CHOICES.fork,
		},
		waitForIdle: async () => {
			operations.push("wait");
		},
		fork: async (entryId: string) => {
			operations.push(`fork:${entryId}`);
			return { cancelled: false, selectedText: "fix the prompt" };
		},
		switchSession: async (sessionFile: string) => {
			operations.push(`switch:${sessionFile}`);
			return { cancelled: false };
		},
	};

	await handlePromptHistorySelection(ctx as never, selection);

	assert.deepEqual(operations.slice(0, 3), [
		"wait",
		"fork:entry-1",
		"set:fix the prompt",
	]);
	assert.equal(
		operations.some((entry) => entry.startsWith("switch:")),
		false,
	);
});
