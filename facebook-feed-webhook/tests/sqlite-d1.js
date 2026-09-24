/**
 * A Cloudflare D1-compatible test double backed by a REAL in-memory SQLite
 * database (node:sqlite), with every migration in database/migrations
 * applied in order. Tests therefore exercise the actual SQL, constraints,
 * UNIQUE / ON CONFLICT semantics and the migrations themselves -- not a
 * regex imitation of them.
 *
 * Implements the subset of the D1 API the Worker uses:
 *   prepare(sql).bind(...args).first() | .all() | .run()
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

function normalizeArgs(args) {
  return args.map((a) => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a));
}

/**
 * @param {{failOn?: RegExp|null}} [options] SQL matching `failOn` throws,
 *   simulating a D1 outage for that statement.
 */
export function createSqliteD1({ failOn = null } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  const statements = [];

  function prepare(sql) {
    statements.push(sql);
    const guard = () => {
      if (failOn && failOn.test(sql)) throw new Error("d1 unavailable (simulated)");
    };
    const bound = (args) => ({
      async first() {
        guard();
        const row = sqlite.prepare(sql).get(...normalizeArgs(args));
        return row === undefined ? null : { ...row };
      },
      async all() {
        guard();
        const rows = sqlite.prepare(sql).all(...normalizeArgs(args)).map((r) => ({ ...r }));
        return { results: rows, success: true, meta: {} };
      },
      async run() {
        guard();
        const info = sqlite.prepare(sql).run(...normalizeArgs(args));
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    });
    return { bind: (...args) => bound(args), ...bound([]) };
  }

  const query = (sql, ...args) => sqlite.prepare(sql).all(...normalizeArgs(args)).map((r) => ({ ...r }));

  return {
    prepare,
    _sqlite: sqlite,
    _query: query,
    _statements: statements,
    _state: {
      get comments() { return query("SELECT * FROM comments ORDER BY id"); },
      get replies() { return query("SELECT * FROM replies ORDER BY id"); },
      get products() { return query("SELECT * FROM products ORDER BY id"); },
      get mappings() { return query("SELECT * FROM content_mappings ORDER BY id"); },
    },
  };
}
