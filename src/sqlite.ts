import { createRequire } from "node:module";

/**
 * Cross-runtime synchronous SQLite adapter.
 *
 * Node introduced `node:sqlite` in v22.5.0. Node 22.5-22.12 and 23.0-23.3
 * require `--experimental-sqlite`; Node 22.13+, 23.4+, and 24+ do not.
 * Some unflagged releases may still emit an `ExperimentalWarning`.
 *
 * Driver differences stay private here: Bun opens `Database` with
 * `{ create: true }`, while Node opens writable `DatabaseSync` immediately and
 * therefore creates a missing file. Only positional `?` bindings are exposed.
 * Bun keeps its native transaction helper; Node uses BEGIN/COMMIT/ROLLBACK.
 * `changes` is normalized to a safe number, while unused `lastInsertRowid` is
 * omitted. Prompt-history pragmas remain portable SQL executed through `exec`.
 */

type SqliteParameter = string | number | bigint | Uint8Array | null;

type SqliteStatement = {
  run(...parameters: SqliteParameter[]): { changes: number };
  get(...parameters: SqliteParameter[]): unknown | undefined;
  all(...parameters: SqliteParameter[]): unknown[];
};

/**
 * Synchronous SQLite operations used by prompt history.
 *
 * This deliberately excludes runtime-specific driver APIs.
 */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  transaction<Args extends unknown[], Result>(
    callback: (...args: Args) => Result,
  ): (...args: Args) => Result;
}

type NativeStatement = {
  run(...parameters: SqliteParameter[]): { changes: number | bigint };
  get(...parameters: SqliteParameter[]): unknown | undefined;
  all(...parameters: SqliteParameter[]): unknown[];
};

type NativeDatabase = {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
};

type BunDatabase = NativeDatabase & {
  transaction<Args extends unknown[], Result>(
    callback: (...args: Args) => Result,
  ): (...args: Args) => Result;
};

type BunSqliteModule = {
  Database: new (path: string, options: { create: boolean }) => BunDatabase;
};

type NodeSqliteModule = {
  DatabaseSync: new (
    path: string,
    options: { open: boolean },
  ) => NativeDatabase;
};

type TransactionStrategy = <Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) => (...args: Args) => Result;

const require = createRequire(import.meta.url);

function normalizeChanges(changes: number | bigint): number {
  const numericChanges = Number(changes);
  if (!Number.isSafeInteger(numericChanges)) {
    throw new RangeError(
      `SQLite change count exceeds JavaScript safe integer range: ${changes}`,
    );
  }
  return numericChanges;
}

class StatementAdapter implements SqliteStatement {
  constructor(private readonly statement: NativeStatement) {}

  run(...parameters: SqliteParameter[]): { changes: number } {
    return {
      changes: normalizeChanges(this.statement.run(...parameters).changes),
    };
  }

  get(...parameters: SqliteParameter[]): unknown | undefined {
    return this.statement.get(...parameters);
  }

  all(...parameters: SqliteParameter[]): unknown[] {
    return this.statement.all(...parameters);
  }
}

class SqliteDatabaseAdapter implements SqliteDatabase {
  constructor(
    private readonly database: NativeDatabase,
    private readonly transactionStrategy: TransactionStrategy,
  ) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new StatementAdapter(this.database.prepare(sql));
  }

  close(): void {
    this.database.close();
  }

  transaction<Args extends unknown[], Result>(
    callback: (...args: Args) => Result,
  ): (...args: Args) => Result {
    return this.transactionStrategy(callback);
  }
}

function nodeTransaction(database: NativeDatabase): TransactionStrategy {
  return (callback) =>
    (...args) => {
      database.exec("BEGIN");
      try {
        const result = callback(...args);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original callback or commit error.
        }
        throw error;
      }
    };
}

function isMissingBunSqliteModule(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return (
    (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
    error.message.includes("bun:sqlite")
  );
}

function loadBunSqlite(): BunSqliteModule | null {
  try {
    return require("bun:sqlite") as BunSqliteModule;
  } catch (error) {
    if (isMissingBunSqliteModule(error)) {
      return null;
    }
    throw error;
  }
}

function nodeSqliteLoadError(error: unknown): Error {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const version = process.versions.node;

  if (major < 22 || (major === 22 && minor < 5)) {
    return new Error(
      `SQLite requires Node.js >=22.5.0 or Bun; detected Node.js v${version}.`,
    );
  }

  if (
    (major === 22 && minor >= 5 && minor < 13) ||
    (major === 23 && minor < 4)
  ) {
    return new Error(
      `Node.js v${version} requires --experimental-sqlite to enable node:sqlite. Restart with that flag or upgrade to Node.js 22.13+, 23.4+, or 24+.`,
    );
  }

  const message = error instanceof Error ? `: ${error.message}` : "";
  return new Error(`Unable to load Node's node:sqlite module${message}`);
}

function loadNodeSqlite(): NodeSqliteModule {
  try {
    const sqlite = require("node:sqlite") as Partial<NodeSqliteModule>;
    if (typeof sqlite.DatabaseSync !== "function") {
      throw new Error("node:sqlite does not export DatabaseSync");
    }
    return sqlite as NodeSqliteModule;
  } catch (error) {
    throw nodeSqliteLoadError(error);
  }
}

/**
 * Open prompt-history storage using Bun when available, otherwise Node's built-in SQLite.
 */
export function openSqliteDatabase(path: string): SqliteDatabase {
  const bunSqlite = loadBunSqlite();
  if (bunSqlite) {
    const database = new bunSqlite.Database(path, { create: true });
    return new SqliteDatabaseAdapter(database, (callback) =>
      database.transaction(callback),
    );
  }

  const nodeSqlite = loadNodeSqlite();
  // Node has no `create` option: opening read/write creates a missing file.
  const database = new nodeSqlite.DatabaseSync(path, { open: true });
  return new SqliteDatabaseAdapter(database, nodeTransaction(database));
}
