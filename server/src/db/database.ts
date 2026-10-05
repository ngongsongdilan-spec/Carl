import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Locates schema.sql.
 *
 * `import.meta.url` is the reliable origin under `tsx`; walking up from the cwd
 * covers the test runner and any layout where the cwd is the repo root. Note
 * that `new URL(...).pathname` is percent-encoded, so a path containing a space
 * must go through `fileURLToPath` instead.
 */
function findSchemaFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'schema.sql'),
    path.join(process.cwd(), 'server', 'src', 'db', 'schema.sql'),
    path.join(process.cwd(), 'src', 'db', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate schema.sql. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * `node:sqlite` is loaded through createRequire rather than a static `import`.
 *
 * A static ESM import of a `node:` builtin works under `tsx` and under plain
 * Node, but bundler-based test runners (Vitest/Vite) strip the `node:` prefix
 * and then look for a `sqlite` package that does not exist. Resolving it at
 * runtime keeps every environment on the same path, and produces one clear
 * failure on Node versions that predate the module.
 */
const nodeRequire = createRequire(import.meta.url);

interface DatabaseSyncCtor {
  new (path: string): DatabaseSyncInstance;
}

type DatabaseSync = DatabaseSyncInstance;

interface DatabaseSyncInstance {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

let DatabaseSync: DatabaseSyncCtor;

try {
  ({ DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: DatabaseSyncCtor });
} catch (err) {
  throw new Error(
    'node:sqlite is unavailable. This project needs Node 22.5 or newer (Node 24 recommended). ' +
      `Original error: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * SQLite access via Node's built-in `node:sqlite`.
 *
 * Chosen deliberately: no native compilation step, so `npm install` cannot fail
 * on a missing build toolchain, and the file format is portable. Every
 * statement below is a prepared statement with positional parameters -- there is
 * no string-concatenated SQL anywhere in this codebase.
 */

export type Row = Record<string, unknown>;

export class Database {
  private readonly db: DatabaseSync;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.restrictPermissions();
  }

  private migrate(): void {
    const sql = fs.readFileSync(findSchemaFile(), 'utf8');
    this.db.exec(sql);
  }

  /** Keeps the database file readable only by the current user where supported. */
  private restrictPermissions(): void {
    if (this.path === ':memory:') return;
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${this.path}${suffix}`;
      try {
        if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
      } catch {
        // Not supported on this platform; documented in SECURITY.md.
      }
    }
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...(params as never[]));
    return (row ?? undefined) as T | undefined;
  }

  all<T = Row>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params as never[])) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // rollback failure must not mask the original error
      }
      throw err;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
