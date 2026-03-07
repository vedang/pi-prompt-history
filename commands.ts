import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { expandHomePath, resolvePromptHistoryConfig } from "./config";
import { PromptHistoryDb } from "./db";
import {
	discoverSessionFiles,
	filterSessionFilesByCwd,
	indexSessionFiles,
	type IndexerResult,
} from "./indexer";
import { searchPrompts, type SearchScope } from "./search";

export function registerPromptHistoryCommands(pi: ExtensionAPI): void {
	pi.registerCommand("prompt-history", {
		description: "Search prompt history in the current working directory",
		handler: async (_args, ctx) => {
			await openPromptHistory(pi, ctx, "local");
		},
	});

	pi.registerCommand("prompt-history-global", {
		description: "Search prompt history across all sessions",
		handler: async (_args, ctx) => {
			await openPromptHistory(pi, ctx, "global");
		},
	});

	pi.registerCommand("prompt-history-reindex", {
		description:
			"Rebuild the prompt-history index (local by default, or global)",
		handler: async (args, ctx) => {
			await reindexPromptHistory(ctx, normalizeScopeArg(args));
		},
	});

	pi.registerCommand("prompt-history-status", {
		description: "Show prompt-history index status",
		handler: async (_args, ctx) => {
			await showPromptHistoryStatus(ctx);
		},
	});

	pi.registerShortcut("ctrl+r", {
		description: "Search prompt history",
		handler: async (ctx) => {
			await openPromptHistory(pi, ctx, "local");
		},
	});
}

export function isPromptHistoryScope(value: unknown): value is SearchScope {
	return value === "local" || value === "global";
}

const normalizeScopeArg = (value: string): SearchScope => {
	const normalized = value.trim().toLowerCase();
	return normalized === "global" || normalized === "all" ? "global" : "local";
};

async function openPromptHistory(
	_pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	initialScope: SearchScope,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("prompt-history requires interactive mode", "error");
		return;
	}

	const config = resolvePromptHistoryConfig();
	const db = new PromptHistoryDb({ path: config.dbPath });

	try {
		await refreshPromptHistoryIndex(db, ctx, "global", false);
		const initialResults = await searchPrompts(db, {
			scope: initialScope,
			cwd: ctx.cwd,
			query: "",
			limit: config.maxResults,
		});

		let tuiRef:
			| {
					requestRender: () => void;
			  }
			| undefined;

		const { PromptHistorySelector } = await import("./selector-ui");
		type PromptHistoryOverlaySelection = {
			item: { text: string };
			scope: SearchScope;
		} | null;
		const selection = await ctx.ui.custom<PromptHistoryOverlaySelection>(
			(tui, theme, _kb, done) => {
				tuiRef = tui;
				return new PromptHistorySelector({
					tui,
					theme,
					initialScope,
					initialResults,
					onSearch: async (query, scope) => {
						return searchPrompts(db, {
							scope,
							cwd: ctx.cwd,
							query,
							limit: config.maxResults,
						});
					},
					onSelect: (result) => done(result),
					onCancel: () => done(null),
				});
			},
			{
				overlay: true,
				overlayOptions: {
					width: "70%",
					minWidth: 60,
					maxHeight: "70%",
					anchor: "center",
					margin: 1,
				},
			},
		);

		if (!selection) {
			return;
		}

		// [tag:prompt_history_selection_replaces_editor_text] Ctrl-R should replace the current editor contents rather than append to it.
		ctx.ui.setEditorText(selection.item.text);
		// [ref:prompt_history_selection_replaces_editor_text]
		tuiRef?.requestRender();
		ctx.ui.notify(`Loaded prompt from ${selection.scope} history`, "info");
	} finally {
		db.close();
	}
}

async function reindexPromptHistory(
	ctx: ExtensionCommandContext,
	scope: SearchScope,
): Promise<void> {
	const config = resolvePromptHistoryConfig();
	const db = new PromptHistoryDb({ path: config.dbPath });

	try {
		const results = await refreshPromptHistoryIndex(db, ctx, scope, true);
		const summary = summarizeIndexerResults(results);
		ctx.ui.notify(`Prompt history reindex (${scope}): ${summary}`, "success");
	} finally {
		db.close();
	}
}

async function showPromptHistoryStatus(
	ctx: ExtensionCommandContext,
): Promise<void> {
	const config = resolvePromptHistoryConfig();
	const db = new PromptHistoryDb({ path: config.dbPath });

	try {
		await refreshPromptHistoryIndex(db, ctx, "global", false);
		const localStats = db.getStats({ scope: "local", cwd: ctx.cwd });
		const globalStats = db.getStats({ scope: "global", cwd: ctx.cwd });
		ctx.ui.notify(
			[
				`Prompt history DB: ${expandHomePath(config.dbPath)}`,
				`Local: ${localStats.promptCount} prompts across ${localStats.sessionCount} sessions`,
				`Global: ${globalStats.promptCount} prompts across ${globalStats.sessionCount} sessions`,
			].join("\n"),
			"info",
		);
	} finally {
		db.close();
	}
}

async function refreshPromptHistoryIndex(
	db: PromptHistoryDb,
	ctx: Pick<ExtensionCommandContext, "cwd" | "sessionManager">,
	scope: SearchScope,
	forceRebuild: boolean,
): Promise<IndexerResult[]> {
	const config = resolvePromptHistoryConfig();
	const sessionFiles = discoverSessionFiles(expandHomePath(config.sessionDir));
	const activeSessionFile = getActiveSessionFile(ctx);
	const filteredFiles =
		scope === "global"
			? sessionFiles
			: filterSessionFilesByCwd(sessionFiles, ctx.cwd);
	const orderedFiles = activeSessionFile
		? [
				activeSessionFile,
				...filteredFiles.filter(
					(sessionFile) => sessionFile !== activeSessionFile,
				),
			]
		: filteredFiles;

	return indexSessionFiles(db, orderedFiles, { forceRebuild });
}

function getActiveSessionFile(
	ctx: Pick<ExtensionCommandContext, "sessionManager">,
): string | undefined {
	const manager = ctx.sessionManager as {
		getSessionFile?: () => string | undefined;
	};
	return manager.getSessionFile?.();
}

function summarizeIndexerResults(results: IndexerResult[]): string {
	const counts = {
		created: 0,
		updated: 0,
		rebuilt: 0,
		skipped: 0,
	};

	for (const result of results) {
		counts[result.action] += 1;
	}

	return [
		`${counts.created} created`,
		`${counts.updated} updated`,
		`${counts.rebuilt} rebuilt`,
		`${counts.skipped} skipped`,
	]
		.join(" • ")
		.trim();
}
