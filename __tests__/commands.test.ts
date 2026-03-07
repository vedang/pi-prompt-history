import assert from "node:assert/strict";
import test from "node:test";

import promptHistoryExtension from "../index";
import { registerPromptHistoryCommands } from "../commands";

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
