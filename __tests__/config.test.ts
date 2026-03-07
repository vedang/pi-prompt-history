import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePromptHistoryConfig } from "../config";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value, null, 2));
}

test("resolvePromptHistoryConfig merges extension, global, and project config files", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-history-config-"));
	const extensionDir = join(root, "extension");
	const homeDir = join(root, "home");
	const cwd = join(root, "project");

	mkdirSync(extensionDir, { recursive: true });
	mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });

	writeJson(join(extensionDir, "config.json"), {
		dbPath: "~/.pi/agent/prompt-history/custom.db",
		maxResults: 12,
		primaryAction: "copy",
	});
	writeJson(
		join(homeDir, ".pi", "agent", "extensions", "prompt-history.json"),
		{
			maxResults: 15,
			primaryAction: "resume",
		},
	);
	writeJson(join(cwd, ".pi", "extensions", "prompt-history.json"), {
		maxResults: 25,
	});

	const config = resolvePromptHistoryConfig({
		cwd,
		extensionDir,
		homeDir,
	});

	assert.equal(config.dbPath, "~/.pi/agent/prompt-history/custom.db");
	assert.equal(config.maxResults, 25);
	assert.equal(config.primaryAction, "resume");
});

test("resolvePromptHistoryConfig falls back to copy-primary when config values are invalid", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-history-config-"));
	const extensionDir = join(root, "extension");

	mkdirSync(extensionDir, { recursive: true });
	writeJson(join(extensionDir, "config.json"), {
		maxResults: -4,
		primaryAction: "launch",
	});

	const config = resolvePromptHistoryConfig({ extensionDir, homeDir: root });

	assert.equal(config.maxResults, 20);
	assert.equal(config.primaryAction, "copy");
});

test("resolvePromptHistoryConfig ignores invalid higher-precedence overrides and keeps lower-precedence valid values", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-history-config-"));
	const extensionDir = join(root, "extension");
	const homeDir = join(root, "home");
	const cwd = join(root, "project");

	mkdirSync(extensionDir, { recursive: true });
	mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });

	writeJson(join(extensionDir, "config.json"), {
		maxResults: 12,
		primaryAction: "copy",
	});
	writeJson(
		join(homeDir, ".pi", "agent", "extensions", "prompt-history.json"),
		{
			maxResults: 15,
			primaryAction: "resume",
		},
	);
	writeJson(join(cwd, ".pi", "extensions", "prompt-history.json"), {
		maxResults: 0,
		primaryAction: "launch",
	});

	const config = resolvePromptHistoryConfig({
		cwd,
		extensionDir,
		homeDir,
	});

	assert.equal(config.maxResults, 15);
	assert.equal(config.primaryAction, "resume");
});
