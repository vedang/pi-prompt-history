import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import type { PromptHistoryConfig } from "./config";
import { copyToClipboard } from "./clipboard";
import { expandHomePath, resolvePromptHistoryConfig } from "./config";
import { PromptHistoryDb } from "./db";
import {
	discoverSessionFiles,
	filterSessionFilesByCwd,
	indexSessionFiles,
	type IndexerResult,
} from "./indexer";
import {
	searchPrompts,
	type PromptSearchResult,
	type SearchOptions,
	type SearchScope,
} from "./search";
import { PROMPT_HISTORY_RESUME_CHOICES } from "./selector";
import type {
	PromptHistorySelector,
	PromptHistorySelectorOptions,
	PromptHistorySelection,
} from "./selector-ui";

export { PROMPT_HISTORY_RESUME_CHOICES };

type PromptHistoryDbLike = Pick<
	PromptHistoryDb,
	"close" | "listRecentPrompts"
> &
	Partial<Pick<PromptHistoryDb, "listPromptCandidates">>;

type PromptHistorySearchOptions = SearchOptions & {
	limit: number;
};

type PromptHistoryIndexContext = Pick<
	ExtensionContext,
	"cwd" | "sessionManager"
>;
type PromptHistoryOpenContext = Pick<
	ExtensionContext,
	"cwd" | "hasUI" | "sessionManager" | "ui"
> &
	Partial<
		Pick<ExtensionCommandContext, "fork" | "switchSession" | "waitForIdle">
	>;

type PromptHistoryResumeMode = "fork" | "restore";

// Shortcut handlers receive ExtensionContext, not ExtensionCommandContext, so
// Ctrl-R resume/fork still needs an internal slash-command handoff to regain
// safe access to switchSession()/fork() when the user presses Enter.
const PROMPT_HISTORY_RESUME_COMMAND = "prompt-history-resume";

type PromptHistoryResumeSelectionContext = Pick<ExtensionContext, "ui"> &
	Partial<Pick<ExtensionCommandContext, "waitForIdle">>;

type PromptHistoryDbContext = Pick<ExtensionCommandContext, "cwd">;

type PromptHistoryResumeRequest = {
	mode: PromptHistoryResumeMode;
	scope: SearchScope;
	sessionFile: string;
	entryId?: string;
	fallbackText?: string;
};

interface OpenPromptHistoryDependencies {
	resolveConfig?: (cwd: string) => PromptHistoryConfig;
	createDb?: (config: PromptHistoryConfig) => PromptHistoryDbLike;
	refreshIndex?: (
		db: PromptHistoryDbLike,
		ctx: PromptHistoryIndexContext,
		scope: SearchScope,
		forceRebuild: boolean,
	) => Promise<IndexerResult[]>;
	search?: (
		db: PromptHistoryDbLike,
		options: PromptHistorySearchOptions,
	) => Promise<PromptSearchResult[]>;
	loadSelector?: () => Promise<{
		PromptHistorySelector: new (
			options: PromptHistorySelectorOptions,
		) => PromptHistorySelector;
	}>;
}

interface PromptHistorySelectionDependencies {
	copyToClipboard?: (text: string) => void;
}

export function registerPromptHistoryCommands(pi: ExtensionAPI): void {
	pi.registerCommand("prompt-history", {
		description: "Search prompt history in the current working directory",
		handler: async (_args, ctx) => {
			await openPromptHistory(ctx, "local");
		},
	});

	pi.registerCommand("prompt-history-global", {
		description: "Search prompt history across all sessions",
		handler: async (_args, ctx) => {
			await openPromptHistory(ctx, "global");
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

	pi.registerCommand(PROMPT_HISTORY_RESUME_COMMAND, {
		description: "Internal helper for prompt-history resume",
		handler: async (args, ctx) => {
			await runPromptHistoryResumeCommand(ctx, args);
		},
	});

	pi.registerShortcut("ctrl+r", {
		description: "Search prompt history",
		handler: async (ctx) => {
			await openPromptHistory(ctx, "local");
		},
	});
}

export function isPromptHistoryScope(value: unknown): value is SearchScope {
	return value === "local" || value === "global";
}

function normalizeScopeArg(value: string): SearchScope {
	const normalized = value.trim().toLowerCase();
	return normalized === "global" || normalized === "all" ? "global" : "local";
}

export async function openPromptHistory(
	ctx: PromptHistoryOpenContext,
	initialScope: SearchScope,
	overrides: OpenPromptHistoryDependencies = {},
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("prompt-history requires interactive mode", "error");
		return;
	}

	const resolveConfig =
		overrides.resolveConfig ??
		((cwd: string) => resolvePromptHistoryConfig({ cwd }));
	const createDb =
		overrides.createDb ??
		((config: PromptHistoryConfig) =>
			new PromptHistoryDb({ path: config.dbPath }));
	const refreshIndex =
		overrides.refreshIndex ??
		(async (db, commandContext, scope, forceRebuild) =>
			refreshPromptHistoryIndex(
				db as PromptHistoryDb,
				commandContext,
				scope,
				forceRebuild,
			));
	const search =
		overrides.search ?? (async (db, options) => searchPrompts(db, options));
	const loadSelector =
		overrides.loadSelector ?? (() => import("./selector-ui"));

	const config = resolveConfig(ctx.cwd);
	const db = createDb(config);
	const initialQuery = ctx.ui.getEditorText();
	const searchWithCurrentContext = (
		query: string,
		scope: SearchScope,
	): Promise<PromptSearchResult[]> =>
		search(db, {
			scope,
			cwd: ctx.cwd,
			query,
			limit: config.maxResults,
		});

	try {
		await refreshIndex(db, ctx, "global", false);
		const initialResults = await searchWithCurrentContext(
			initialQuery,
			initialScope,
		);

		const { PromptHistorySelector } = await loadSelector();
		const selection = await ctx.ui.custom<PromptHistorySelection | null>(
			(tui, theme, _kb, done) =>
				new PromptHistorySelector({
					tui,
					theme,
					initialScope,
					initialResults,
					initialQuery,
					primaryAction: config.primaryAction,
					currentCwd: ctx.cwd,
					activeSessionFile: getActiveSessionFile(ctx),
					onSearch: searchWithCurrentContext,
					onSelect: (result) => done(result),
					onCancel: () => done(null),
				}),
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

		if (
			selection.action === "resume" &&
			!supportsPromptHistorySessionControl(ctx)
		) {
			await queuePromptHistoryResume(ctx, selection);
			return;
		}

		await handlePromptHistorySelection(
			ctx as ExtensionCommandContext,
			selection,
		);
	} finally {
		db.close();
	}
}

export async function handlePromptHistorySelection(
	ctx: ExtensionCommandContext,
	selection: PromptHistorySelection,
	deps: PromptHistorySelectionDependencies = {},
): Promise<void> {
	if (selection.action === "copy") {
		// [tag:prompt_history_selection_replaces_editor_text] Ctrl-R should replace the current editor contents rather than append to it.
		ctx.ui.setEditorText(selection.item.text);
		(deps.copyToClipboard ?? copyToClipboard)(selection.item.text);
		// [ref:prompt_history_selection_replaces_editor_text]
		ctx.ui.notify(`Loaded prompt from ${selection.scope} history`, "info");
		return;
	}

	const mode = await selectPromptHistoryResumeMode(ctx);
	if (!mode) {
		return;
	}

	await performPromptHistoryResume(
		ctx,
		createPromptHistoryResumeRequest(selection, mode),
	);
}

async function runPromptHistoryResumeCommand(
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	const request = parsePromptHistoryResumeRequest(args);
	if (!request) {
		ctx.ui.notify("Invalid prompt-history resume request", "error");
		return;
	}

	await performPromptHistoryResume(ctx, request);
}

async function queuePromptHistoryResume(
	ctx: PromptHistoryResumeSelectionContext,
	selection: PromptHistorySelection,
): Promise<void> {
	const mode = await selectPromptHistoryResumeMode(ctx);
	if (!mode) {
		return;
	}

	ctx.ui.setEditorText(
		buildPromptHistoryResumeCommand(
			createPromptHistoryResumeRequest(selection, mode),
		),
	);
	ctx.ui.notify("Resume command ready. Press Enter to continue.", "info");
}

function supportsPromptHistorySessionControl(
	ctx: PromptHistoryOpenContext,
): ctx is ExtensionCommandContext {
	return (
		typeof ctx.fork === "function" && typeof ctx.switchSession === "function"
	);
}

async function selectPromptHistoryResumeMode(
	ctx: PromptHistoryResumeSelectionContext,
): Promise<PromptHistoryResumeMode | null> {
	if (typeof ctx.waitForIdle === "function") {
		await ctx.waitForIdle();
	}

	const choice = await ctx.ui.select(
		"Resume session: fork from this point or restore the entire session?",
		[PROMPT_HISTORY_RESUME_CHOICES.fork, PROMPT_HISTORY_RESUME_CHOICES.restore],
	);
	if (!choice) {
		return null;
	}

	return choice === PROMPT_HISTORY_RESUME_CHOICES.restore ? "restore" : "fork";
}

async function performPromptHistoryResume(
	ctx: ExtensionCommandContext,
	request: PromptHistoryResumeRequest,
): Promise<void> {
	if (request.mode === "restore") {
		const result = await ctx.switchSession(request.sessionFile);
		if (!result.cancelled) {
			ctx.ui.notify(`Restored session from ${request.scope} history`, "info");
		}
		return;
	}

	const activeSessionFile = getActiveSessionFile(ctx);
	if (activeSessionFile !== request.sessionFile) {
		const switchResult = await ctx.switchSession(request.sessionFile);
		if (switchResult.cancelled) {
			return;
		}
	}

	const forkResult = (await ctx.fork(request.entryId ?? "")) as {
		cancelled: boolean;
		selectedText?: string;
	};
	if (!forkResult.cancelled) {
		const text = forkResult.selectedText ?? request.fallbackText;
		if (text !== undefined) {
			ctx.ui.setEditorText(text);
		}
		ctx.ui.notify(`Forked from ${request.scope} history`, "info");
	}
}

function createPromptHistoryResumeRequest(
	selection: PromptHistorySelection,
	mode: PromptHistoryResumeMode,
): PromptHistoryResumeRequest {
	return {
		mode,
		scope: selection.scope,
		sessionFile: selection.item.sessionFile,
		entryId: selection.item.id,
		fallbackText: selection.item.text,
	};
}

function buildPromptHistoryResumeCommand(
	request: PromptHistoryResumeRequest,
): string {
	const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
	return `/${PROMPT_HISTORY_RESUME_COMMAND} ${encoded}`;
}

function parsePromptHistoryResumeRequest(
	args: string,
): PromptHistoryResumeRequest | null {
	const encoded = args.trim();
	if (!encoded) {
		return null;
	}

	try {
		const parsed = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		) as Partial<PromptHistoryResumeRequest>;
		if (!parsed || typeof parsed !== "object") {
			return null;
		}
		if (!isPromptHistoryScope(parsed.scope)) {
			return null;
		}
		if (
			typeof parsed.sessionFile !== "string" ||
			parsed.sessionFile.length === 0
		) {
			return null;
		}
		if (parsed.mode !== "fork" && parsed.mode !== "restore") {
			return null;
		}
		if (
			parsed.mode === "fork" &&
			(typeof parsed.entryId !== "string" || parsed.entryId.length === 0)
		) {
			return null;
		}

		return {
			mode: parsed.mode,
			scope: parsed.scope,
			sessionFile: parsed.sessionFile,
			entryId: parsed.entryId,
			fallbackText:
				typeof parsed.fallbackText === "string"
					? parsed.fallbackText
					: undefined,
		};
	} catch {
		return null;
	}
}

async function withPromptHistoryDb<T>(
	ctx: PromptHistoryDbContext,
	handler: (db: PromptHistoryDb, config: PromptHistoryConfig) => Promise<T>,
): Promise<T> {
	const config = resolvePromptHistoryConfig({ cwd: ctx.cwd });
	const db = new PromptHistoryDb({ path: config.dbPath });

	try {
		return await handler(db, config);
	} finally {
		db.close();
	}
}

async function reindexPromptHistory(
	ctx: ExtensionCommandContext,
	scope: SearchScope,
): Promise<void> {
	await withPromptHistoryDb(ctx, async (db) => {
		const results = await refreshPromptHistoryIndex(db, ctx, scope, true);
		const summary = summarizeIndexerResults(results);
		ctx.ui.notify(`Prompt history reindex (${scope}): ${summary}`, "success");
	});
}

async function showPromptHistoryStatus(
	ctx: ExtensionCommandContext,
): Promise<void> {
	await withPromptHistoryDb(ctx, async (db, config) => {
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
	});
}

async function refreshPromptHistoryIndex(
	db: PromptHistoryDb,
	ctx: PromptHistoryIndexContext,
	scope: SearchScope,
	forceRebuild: boolean,
): Promise<IndexerResult[]> {
	const config = resolvePromptHistoryConfig({ cwd: ctx.cwd });
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
	ctx: Partial<Pick<PromptHistoryIndexContext, "sessionManager">>,
): string | undefined {
	const manager = ctx.sessionManager as
		| {
				getSessionFile?: () => string | undefined;
		  }
		| undefined;
	return manager?.getSessionFile?.();
}

const INDEXER_ACTION_ORDER = [
	"created",
	"updated",
	"rebuilt",
	"skipped",
] as const;

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

	return INDEXER_ACTION_ORDER.map(
		(action) => `${counts[action]} ${action}`,
	).join(" • ");
}
