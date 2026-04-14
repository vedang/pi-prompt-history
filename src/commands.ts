import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { copyToClipboard } from "./clipboard";
import type { PromptHistoryConfig } from "./config";
import { expandHomePath, resolvePromptHistoryConfig } from "./config";
import { PromptHistoryDb } from "./db";
import {
  type IndexerAction,
  type IndexerResult,
  discoverSessionFiles,
  discoverSessionFilesByCwd,
  indexSessionFiles,
} from "./indexer";
import {
  type PromptSearchResult,
  type SearchOptions,
  type SearchScope,
  searchPrompts,
} from "./search";
import { PROMPT_HISTORY_RESUME_CHOICES } from "./selector";
import type {
  PromptHistorySelection,
  PromptHistorySelector,
  PromptHistorySelectorOptions,
} from "./selector-ui";

export { PROMPT_HISTORY_RESUME_CHOICES };

type PromptHistoryDbLike = Pick<
  PromptHistoryDb,
  "close" | "listRecentPrompts"
> &
  Partial<Pick<PromptHistoryDb, "listPromptCandidates">>;

type PromptHistorySearchOptions = SearchOptions & { limit: number };

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

function supportsPromptHistorySessionControl(
  ctx: PromptHistoryOpenContext,
): ctx is ExtensionCommandContext {
  return (
    typeof ctx.fork === "function" && typeof ctx.switchSession === "function"
  );
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
  const refreshedScopes = new Map<SearchScope, Promise<void>>();
  const ensureScopeRefreshed = (scope: SearchScope): Promise<void> => {
    const existing = refreshedScopes.get(scope);
    if (existing) return existing;

    const wrapped = refreshIndex(db, ctx, scope, false)
      .then(() => {})
      .catch((error) => {
        refreshedScopes.delete(scope);
        throw error;
      });
    refreshedScopes.set(scope, wrapped);
    return wrapped;
  };

  const searchWithCurrentContext = (
    query: string,
    scope: SearchScope,
  ): Promise<PromptSearchResult[]> =>
    ensureScopeRefreshed(scope).then(() =>
      search(db, {
        scope,
        cwd: ctx.cwd,
        query,
        limit: config.maxResults,
      }),
    );

  try {
    const initialResults = await searchWithCurrentContext(
      initialQuery,
      initialScope,
    );

    const { PromptHistorySelector } = await loadSelector();
    const selection = await ctx.ui.custom<PromptHistorySelection | null>(
      (tui, theme, keybindings, done) =>
        new PromptHistorySelector({
          tui,
          theme: theme as PromptHistorySelectorOptions["theme"],
          initialScope,
          initialResults,
          initialQuery,
          primaryAction: config.primaryAction,
          currentCwd: ctx.cwd,
          activeSessionFile: getActiveSessionFile(ctx),
          keybindings,
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

  const request = createPromptHistoryResumeRequest(selection, mode);
  ctx.ui.setEditorText(buildPromptHistoryResumeCommand(request));

  const actionLabel =
    mode === "restore" ? "Restore full session" : "Fork from selected prompt";
  ctx.ui.notify(
    `${actionLabel}. Press Enter to continue, or Esc to cancel.`,
    "info",
  );
}

async function selectPromptHistoryResumeMode(
  ctx: PromptHistoryResumeSelectionContext,
): Promise<PromptHistoryResumeMode | null> {
  await ctx.waitForIdle?.();
  const choice = await ctx.ui.select(
    "Resume session: fork from this point or restore the entire session?",
    [PROMPT_HISTORY_RESUME_CHOICES.fork, PROMPT_HISTORY_RESUME_CHOICES.restore],
  );
  return choice === PROMPT_HISTORY_RESUME_CHOICES.restore
    ? "restore"
    : choice
      ? "fork"
      : null;
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

  // Fork mode: switch to session first if needed
  if (getActiveSessionFile(ctx) !== request.sessionFile) {
    const switchResult = await ctx.switchSession(request.sessionFile);
    if (switchResult.cancelled) return;
  }

  const forkResult = (await ctx.fork(request.entryId ?? "")) as {
    cancelled: boolean;
    selectedText?: string;
  };
  if (forkResult.cancelled) return;

  const text = forkResult.selectedText ?? request.fallbackText;
  if (text !== undefined) ctx.ui.setEditorText(text);
  ctx.ui.notify(`Forked from ${request.scope} history`, "info");
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
  return `/${PROMPT_HISTORY_RESUME_COMMAND} ${Buffer.from(JSON.stringify(request)).toString("base64url")}`;
}

function parsePromptHistoryResumeRequest(
  args: string,
): PromptHistoryResumeRequest | null {
  const encoded = args.trim();
  if (!encoded) return null;

  let parsed: Partial<PromptHistoryResumeRequest>;
  try {
    parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<PromptHistoryResumeRequest>;
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !isPromptHistoryScope(parsed.scope) ||
    typeof parsed.sessionFile !== "string" ||
    !parsed.sessionFile ||
    (parsed.mode !== "fork" && parsed.mode !== "restore") ||
    (parsed.mode === "fork" && typeof parsed.entryId !== "string")
  ) {
    return null;
  }

  return {
    mode: parsed.mode,
    scope: parsed.scope,
    sessionFile: parsed.sessionFile,
    entryId: parsed.entryId,
    fallbackText:
      typeof parsed.fallbackText === "string" ? parsed.fallbackText : undefined,
  };
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
    ctx.ui.notify(`Prompt history reindex (${scope}): ${summary}`, "info");
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
  const sessionDir = expandHomePath(config.sessionDir);

  // For local scope, discover files from the filesystem for the current cwd.
  // This ensures new sessions that haven't been indexed yet are found,
  // not just sessions already in the DB.
  const filteredFiles =
    scope === "global"
      ? discoverSessionFiles(sessionDir)
      : discoverSessionFilesByCwd(sessionDir, ctx.cwd);

  // Put active session first if it exists
  const active = getActiveSessionFile(ctx);
  const orderedFiles = active
    ? [active, ...filteredFiles.filter((f) => f !== active)]
    : filteredFiles;

  return indexSessionFiles(db, orderedFiles, { forceRebuild });
}

function getActiveSessionFile(
  ctx: Partial<Pick<PromptHistoryIndexContext, "sessionManager">>,
): string | undefined {
  return (
    ctx.sessionManager as { getSessionFile?: () => string | undefined }
  )?.getSessionFile?.();
}

const INDEXER_ACTIONS: IndexerAction[] = [
  "created",
  "updated",
  "rebuilt",
  "skipped",
];

function summarizeIndexerResults(results: IndexerResult[]): string {
  return INDEXER_ACTIONS.map(
    (action) =>
      `${results.filter((r) => r.action === action).length} ${action}`,
  ).join(" • ");
}
