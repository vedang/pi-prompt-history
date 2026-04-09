import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

const requiredFiles = [
  "src/index.ts",
  "src/config.ts",
  "src/db.ts",
  "src/parser.ts",
  "src/indexer.ts",
  "src/search.ts",
  "src/selector.ts",
  "src/commands.ts",
  "src/selector-ui.ts",
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

test("index.ts delegates prompt-history setup through commands module", () => {
  const source = readFileSync(join(extensionDir, "src/index.ts"), "utf-8");
  assert.match(source, /registerPromptHistoryCommands/);
});
