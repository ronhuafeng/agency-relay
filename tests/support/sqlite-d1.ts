import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export interface TestD1 {
  binding: D1Database;
  sqlite: DatabaseSync;
  close(): void;
}

export function createTestD1(options: {
  migrations?: "all" | "none" | readonly string[];
  file?: string;
  timeout?: number;
  onPrepare?: (sql: string) => void;
  onBind?: (sql: string, values: readonly unknown[]) => void;
  beforeRun?: (sql: string) => void | Promise<void>;
  onBatch?: () => void;
} = {}): TestD1 {
  const sqlite = new DatabaseSync(options.file ?? ":memory:", {
    timeout: options.timeout ?? (options.file ? 5_000 : 0)
  });
  if (options.file) sqlite.exec("PRAGMA journal_mode = WAL");
  if (options.migrations !== "none") {
    const migrations = options.migrations === undefined || options.migrations === "all"
      ? migrationNames()
      : options.migrations;
    for (const migration of migrations) {
      sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
    }
  }
  return {
    binding: new SqliteD1(sqlite, options) as unknown as D1Database,
    sqlite,
    close: () => sqlite.close()
  };
}

function migrationNames(): string[] {
  return readdirSync(new URL("../../migrations", import.meta.url))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

class SqliteD1 {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly hooks: {
      onPrepare?: (sql: string) => void;
      onBind?: (sql: string, values: readonly unknown[]) => void;
      beforeRun?: (sql: string) => void | Promise<void>;
      onBatch?: () => void;
    }
  ) {}

  prepare(sql: string): SqliteD1Statement {
    this.hooks.onPrepare?.(sql);
    return new SqliteD1Statement(this.sqlite.prepare(sql), sql, this.hooks);
  }

  async batch(statements: SqliteD1Statement[]): Promise<unknown[]> {
    this.hooks.onBatch?.();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        if (!(statement instanceof SqliteD1Statement)) {
          throw new TypeError("SQLite D1 batch received a statement from another Adapter");
        }
        results.push(await statement.batchResult());
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteD1Statement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly statement: StatementSync,
    private readonly sql: string,
    private readonly hooks: {
      onBind?: (sql: string, values: readonly unknown[]) => void;
      beforeRun?: (sql: string) => void | Promise<void>;
    }
  ) {}

  bind(...values: unknown[]): this {
    this.hooks.onBind?.(this.sql, values);
    this.values = values.map(toSqliteValue);
    return this;
  }

  async first<T>(columnName?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return null;
    }
    return (columnName === undefined ? row : row[columnName]) as T;
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: Record<string, never> }> {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: {}
    };
  }

  async run(): Promise<{
    success: true;
    results: never[];
    meta: { changes: number; last_row_id: number };
  }> {
    await this.hooks.beforeRun?.(this.sql);
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid)
      }
    };
  }

  async batchResult(): Promise<{
    success: true;
    results: Record<string, unknown>[];
    meta: { changes: number; last_row_id: number };
  }> {
    await this.hooks.beforeRun?.(this.sql);
    if (this.statement.columns().length > 0) {
      return {
        success: true,
        results: this.statement.all(...this.values) as Record<string, unknown>[],
        meta: { changes: 0, last_row_id: 0 }
      };
    }
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid)
      }
    };
  }
}

function toSqliteValue(value: unknown): SQLInputValue {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value as SQLInputValue;
}
