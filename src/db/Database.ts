import initSqlJs, { Database as SqlJsDatabase, Statement as SqlJsStatement } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

// Statement wrapper to match better-sqlite3 API
export interface Statement<T = unknown> {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
}

// Initialize sql.js at module load time using top-level await
const SQL = await initSqlJs();

/**
 * Database wrapper with file persistence and transaction support
 * Uses sql.js (pure JS/WASM) for universal compatibility
 */
export class Database {
  private db: SqlJsDatabase | null;
  private readonly dbPath: string;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private closed: boolean = false;
  private inTransaction: boolean = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Clean up WAL/SHM files from previous better-sqlite3 usage
    for (const suffix of ['-wal', '-shm']) {
      const p = `${dbPath}${suffix}`;
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }

    if (fs.existsSync(dbPath)) {
      try {
        const buffer = fs.readFileSync(dbPath);
        this.db = new SQL.Database(buffer);
        this.db.exec('SELECT 1');
      } catch {
        const backupPath = `${dbPath}.corrupt.${Date.now()}`;
        try {
          fs.renameSync(dbPath, backupPath);
          console.error(`Database corrupted, backed up to: ${backupPath}`);
        } catch {
          fs.unlinkSync(dbPath);
          console.error('Database corrupted and removed, starting fresh');
        }
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }

    this.saveNow();
  }

  private scheduleSave(): void {
    if (this.inTransaction) return;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.saveNow(), 100);
  }

  private saveNow(): void {
    if (!this.db || this.closed) return;
    const data = this.db.export();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  close(): void {
    if (this.closed) return;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveNow();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.closed = true;
  }

  private ensureOpen(): SqlJsDatabase {
    if (!this.db || this.closed) throw new Error('Database is not open');
    return this.db;
  }

  exec(sql: string): void {
    const db = this.ensureOpen();
    db.exec(sql);
    this.scheduleSave();
  }

  prepare<T = unknown>(sql: string): Statement<T> {
    const db = this.ensureOpen();
    const self = this;

    return {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
        db.run(sql, params as (string | number | null | Uint8Array)[]);
        self.scheduleSave();
        return { changes: 0, lastInsertRowid: 0 };
      },

      get(...params: unknown[]): T | undefined {
        const stmt = db.prepare(sql);
        stmt.bind(params as (string | number | null | Uint8Array)[]);

        if (stmt.step()) {
          const columns = stmt.getColumnNames();
          const values = stmt.get();
          stmt.free();
          if (values) {
            const row: Record<string, unknown> = {};
            for (let i = 0; i < columns.length; i++) {
              row[columns[i]] = values[i];
            }
            return row as T;
          }
        }
        stmt.free();
        return undefined;
      },

      all(...params: unknown[]): T[] {
        const stmt = db.prepare(sql);
        stmt.bind(params as (string | number | null | Uint8Array)[]);

        const results: T[] = [];
        const columns = stmt.getColumnNames();
        while (stmt.step()) {
          const values = stmt.get();
          if (values) {
            const row: Record<string, unknown> = {};
            for (let i = 0; i < columns.length; i++) {
              row[columns[i]] = values[i];
            }
            results.push(row as T);
          }
        }
        stmt.free();
        return results;
      }
    };
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    const db = this.ensureOpen();
    const self = this;
    return (...args: any[]) => {
      db.run('BEGIN TRANSACTION');
      self.inTransaction = true;
      try {
        const result = fn(...args);
        db.run('COMMIT');
        self.inTransaction = false;
        self.scheduleSave();
        return result;
      } catch (err) {
        db.run('ROLLBACK');
        self.inTransaction = false;
        throw err;
      }
    };
  }
}
