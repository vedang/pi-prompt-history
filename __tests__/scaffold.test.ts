import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

const requiredFiles = [
	"index.ts",
	"config.ts",
	"db.ts",
	"parser.ts",
	"indexer.ts",
	"search.ts",
	"selector.ts",
	"commands.ts",
	"README.md",
	"package.json",
];

const extensionDir = join(fixtureDir, "..");

test("prompt-history scaffold files exist", () => {
	for (const file of requiredFiles) {
		assert.ok(
			existsSync(join(extensionDir, file)),
			`Expected scaffold file to exist: ${file}`,
		);
	}
});

test("index.ts delegates prompt-history setup through commands + config modules", () => {
	const source = readFileSync(join(extensionDir, "index.ts"), "utf-8");
	assert.match(source, /registerPromptHistoryCommands/);
	assert.match(source, /initializePromptHistoryConfig/);
});
