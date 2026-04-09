SHELL := /bin/bash
.SHELLFLAGS := -Eeuo pipefail -c

.DEFAULT_GOAL := help

TS_SCOPE ?= src __tests__ package.json tsconfig.json biome.json knip.json vitest.config.unit.ts vitest.config.integration.ts vitest.config.llm.ts .jscpd.json
TEST_FILES := $(shell find __tests__ -type f -name "*.test.ts" 2>/dev/null)
TEST_FILES_UNIT := $(TEST_FILES)
TEST_FILES_INTEGRATION := $(shell find __tests__/integration -type f -name "*.test.ts" 2>/dev/null)
TEST_FILES_LLM := $(shell find __tests__/llm -type f -name "*.test.ts" 2>/dev/null)

.PHONY: help
help: ## Show available targets
	@awk '/^[a-zA-Z0-9_-]+:.*##/ { \
		printf "%-25s # %s\n", \
		substr($$1, 1, length($$1)-1), \
		substr($$0, index($$0, "##") + 3) \
	}' $(MAKEFILE_LIST)

.PHONY: ci
ci:
	bun install --frozen-lockfile

.PHONY: init
init: ## Bootstrap dependencies and setup
	bun install

.PHONY: upgrade-deps
upgrade-deps: ## Upgrade all dependencies to their latest versions
	bun update

.PHONY: check-tagref
check-tagref:
	@if command -v tagref >/dev/null 2>&1; then \
		tagref; \
	else \
		echo "tagref not installed; skipping tagref validation"; \
	fi

.PHONY: check-biome
check-biome:
	bunx @biomejs/biome check $(TS_SCOPE)

.PHONY: check-typescript
check-typescript:
	bunx tsc --noEmit -p tsconfig.json

.PHONY: check-knip
check-knip:
	bunx knip

.PHONY: check-jscpd
check-jscpd:
	bunx jscpd $(TS_SCOPE)

.PHONY: check
check: check-biome check-typescript check-tagref check-knip check-jscpd ## Run all repository checks
	@echo "All checks passed!"

.PHONY: format
format: ## Format project files with Biome
	bunx @biomejs/biome check --write $(TS_SCOPE)

.PHONY: test-unit
test-unit:
	@if [ -n "$(strip $(TEST_FILES_UNIT))" ]; then \
		bun test $(TEST_FILES_UNIT); \
	else \
		echo "No unit tests found under __tests__; skipping"; \
	fi

.PHONY: test-llm
test-llm:
	@if [ -n "$(strip $(TEST_FILES_LLM))" ]; then \
		bun test $(TEST_FILES_LLM); \
	else \
		echo "No LLM tests found under __tests__/llm; skipping"; \
	fi

.PHONY: test-integration
test-integration:
	@if [ -n "$(strip $(TEST_FILES_INTEGRATION))" ]; then \
		bun test $(TEST_FILES_INTEGRATION); \
	else \
		echo "No integration tests found under __tests__/integration; skipping"; \
	fi

.PHONY: test
test: test-unit ## Run the default test suite

.PHONY: dev
dev: ## Run local TypeScript watch compilation
	bun run dev

.PHONY: build
build: check ## Build the TypeScript package
	bun run build

.PHONY: clean
clean: ## Delete generated artifacts
	rm -rf node_modules/
	rm -rf dist/
	rm -rf coverage/
	rm -f *.tsbuildinfo

.PHONY: install-hooks
install-hooks: .git/hooks/pre-push

.git/hooks/pre-push:
	@echo "Setting up Git hooks..."
	@printf '%s\n' '#!/bin/sh' 'set -eu' '' 'exec 1>&2' '' 'echo "Running pre-push checks..."' 'make check' 'make format' 'if ! git diff --exit-code --quiet; then' '  echo "Formatting changed tracked files. Commit the results before pushing."' '  exit 1' 'fi' 'make test' > .git/hooks/pre-push
	@chmod +x .git/hooks/pre-push
	@echo "✅ Git hooks installed successfully!"
