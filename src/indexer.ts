import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { IndexedSessionMetadata, PromptHistoryDb } from "./db";
import type { ParsedSessionPrompt } from "./parser";
import { parseSessionFile } from "./parser";

export type IndexerAction = "created" | "updated" | "rebuilt" | "skipped";

export interface IndexerResult {
  action: IndexerAction;
  indexedPrompts: number;
  sessionFile?: string;
}

export interface IndexSessionFileOptions {
  forceRebuild?: boolean;
}

interface SessionFileStats {
  size: number;
  mtimeMs: number;
}

export async function indexSessionFile(
  db: PromptHistoryDb,
  sessionFile: string,
  options: IndexSessionFileOptions = {},
): Promise<IndexerResult> {
  const existingSession = db.getIndexedSession(sessionFile);
  const fileStats = statSessionFile(sessionFile);

  if (fileStats === null) {
    db.clearSessionPrompts(sessionFile);
    return createIndexerResult("skipped", 0, sessionFile);
  }

  if (
    isSessionFileUnchanged(existingSession, fileStats, options.forceRebuild)
  ) {
    return createIndexerResult("skipped", 0, sessionFile);
  }

  const parsedSession = await parseSessionFile(sessionFile);
  if (parsedSession === null) {
    return createIndexerResult("skipped", 0, sessionFile);
  }

  const indexedAtMs = Date.now();
  db.upsertSession({
    sessionFile,
    cwd: parsedSession.cwd,
    sessionName: parsedSession.sessionName,
    indexedMtimeMs: fileStats.mtimeMs,
    indexedSizeBytes: fileStats.size,
    indexedPromptCount: parsedSession.prompts.length,
    lastIndexedAtMs: indexedAtMs,
  });

  const action = getIndexAction(
    existingSession,
    fileStats,
    options.forceRebuild,
  );
  if (action === "rebuilt") {
    db.clearSessionPrompts(sessionFile);
  }

  const indexedPrompts = indexPrompts(
    db,
    parsedSession.prompts,
    parsedSession.sessionName,
    indexedAtMs,
  );
  return createIndexerResult(action, indexedPrompts, sessionFile);
}

export async function indexSessionFiles(
  db: PromptHistoryDb,
  sessionFiles: string[],
  options: IndexSessionFileOptions = {},
): Promise<IndexerResult[]> {
  const results: IndexerResult[] = [];
  for (const sessionFile of sessionFiles) {
    results.push(await indexSessionFile(db, sessionFile, options));
  }
  return results;
}

export function discoverSessionFiles(sessionDir: string): string[] {
  const results: string[] = [];
  for (const entry of walkEntries(sessionDir)) {
    if (entry.endsWith(".jsonl")) {
      results.push(entry);
    }
  }
  return results.sort();
}

/**
 * Convert a cwd (e.g. "/Users/nejo/foo") into the session directory name
 * used by pi (e.g. "--Users-nejo-foo--").
 *
 * The convention is: strip the leading "/", replace all "/" with "-",
 * then wrap with "--" on both sides.
 */
function cwdToSessionDirName(cwd: string): string {
  const stripped = cwd.startsWith("/") ? cwd.slice(1) : cwd;
  return `--${stripped.replace(/\//g, "-")}--`;
}

/**
 * Discover session files from the filesystem for a specific cwd.
 * Uses the pi session directory naming convention to scan only the
 * relevant subdirectory, avoiding a full tree walk.
 */
export function discoverSessionFilesByCwd(
  sessionDir: string,
  cwd: string,
): string[] {
  const dirName = cwdToSessionDirName(cwd);
  const cwdDir = join(sessionDir, dirName);
  return discoverSessionFiles(cwdDir);
}

function walkEntries(rootDir: string): string[] {
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const path = join(rootDir, entry.name);
      return entry.isDirectory() ? walkEntries(path) : [path];
    });
  } catch {
    return [];
  }
}

function createIndexerResult(
  action: IndexerAction,
  indexedPrompts: number,
  sessionFile: string,
): IndexerResult {
  return { action, indexedPrompts, sessionFile };
}

function isSessionFileUnchanged(
  existingSession: IndexedSessionMetadata | null,
  fileStats: SessionFileStats,
  forceRebuild = false,
): boolean {
  return Boolean(
    !forceRebuild &&
      existingSession &&
      existingSession.indexedSizeBytes === fileStats.size &&
      existingSession.indexedMtimeMs === fileStats.mtimeMs,
  );
}

function getIndexAction(
  existingSession: IndexedSessionMetadata | null,
  fileStats: SessionFileStats,
  forceRebuild = false,
): Exclude<IndexerAction, "skipped"> {
  if (existingSession === null) {
    return "created";
  }

  return forceRebuild || fileStats.size < existingSession.indexedSizeBytes
    ? "rebuilt"
    : "updated";
}

function indexPrompts(
  db: PromptHistoryDb,
  prompts: ParsedSessionPrompt[],
  sessionName: string,
  indexedAtMs: number,
): number {
  return db.insertPrompts(
    prompts.map((prompt) => ({
      sessionFile: prompt.sessionFile,
      entryId: prompt.entryId,
      parentId: prompt.parentId,
      sessionName,
      cwd: prompt.cwd,
      promptTimestampMs: prompt.promptTimestampMs,
      ordinalInSession: prompt.ordinalInSession,
      text: prompt.text,
      preview: prompt.preview,
      contentHash: prompt.contentHash,
    })),
    indexedAtMs,
  );
}

function statSessionFile(path: string): SessionFileStats | null {
  try {
    const stats = statSync(path);
    return {
      size: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
    };
  } catch {
    return null;
  }
}
