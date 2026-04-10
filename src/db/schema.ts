import { Database } from "./Database.js";

export function initializeDatabase(dbPath: string): Database {
  const db = new Database(dbPath);

  db.exec(`
    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project_slug TEXT NOT NULL,
      project_path TEXT,
      slug TEXT,
      custom_title TEXT,
      first_prompt TEXT,
      started_at TEXT,
      last_activity TEXT,
      git_branch TEXT,
      has_full_transcript INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      indexed_at TEXT,
      outcome TEXT,
      error_count INTEGER DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_seconds INTEGER,
      importance_score REAL DEFAULT 0.0
    );

    -- Messages table (only user text + assistant text, NOT tool results)
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT,
      message_index INTEGER,
      importance REAL DEFAULT 0,
      message_type TEXT DEFAULT 'content',
      UNIQUE(session_id, message_index)
    );

    -- Standalone FTS4 index on messages (stores its own content)
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts4(
      session_id,
      role,
      content,
      message_index,
      tokenize=porter unicode61
    );

    -- Tool usage tracking
    CREATE TABLE IF NOT EXISTS tool_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      file_path TEXT,
      timestamp TEXT
    );

    -- History entries (from history.jsonl, covers ALL sessions)
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT,
      display TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    -- Standalone FTS4 on history
    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts4(
      session_id,
      project_path,
      display,
      tokenize=porter unicode61
    );

    -- Session insights (decisions, fixes, etc.)
    CREATE TABLE IF NOT EXISTS session_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      insight_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      confidence REAL DEFAULT 0.5,
      source_index INTEGER,
      UNIQUE(session_id, insight_type, source_index)
    );

    -- Session tags
    CREATE TABLE IF NOT EXISTS session_tags (
      session_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY(session_id, tag)
    );

    -- Cross-project references
    CREATE TABLE IF NOT EXISTS cross_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_session_id TEXT NOT NULL,
      source_project TEXT NOT NULL,
      target_project TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      context TEXT,
      message_index INTEGER
    );

    -- FTS on insights
    CREATE VIRTUAL TABLE IF NOT EXISTS insights_fts USING fts4(
      session_id,
      insight_type,
      summary,
      detail,
      tokenize=porter unicode61
    );

    -- Index metadata (for incremental updates)
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_usage_session ON tool_usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_usage_file ON tool_usage(file_path) WHERE file_path IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_name);
    CREATE INDEX IF NOT EXISTS idx_history_session ON history(session_id);
    CREATE INDEX IF NOT EXISTS idx_history_project ON history(project_path);
    CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp);
    CREATE INDEX IF NOT EXISTS idx_insights_session ON session_insights(session_id);
    CREATE INDEX IF NOT EXISTS idx_insights_type ON session_insights(insight_type);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON session_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_cross_refs_source ON cross_references(source_project);
    CREATE INDEX IF NOT EXISTS idx_cross_refs_target ON cross_references(target_project);
  `);

  // Migration: recreate messages_fts if it has old schema (3 columns -> 4)
  try {
    const ftsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'").get() as { sql: string } | undefined;
    if (ftsInfo && !ftsInfo.sql.includes('message_index')) {
      db.exec('DROP TABLE IF EXISTS messages_fts');
      db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts4(
        session_id, role, content, message_index,
        tokenize=porter unicode61
      )`);
    }
  } catch { /* ignore */ }

  // Migration: add columns to existing databases
  const migrations = [
    'ALTER TABLE sessions ADD COLUMN outcome TEXT',
    'ALTER TABLE sessions ADD COLUMN error_count INTEGER DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN commit_count INTEGER DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN total_tokens INTEGER DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN duration_seconds INTEGER',
    'ALTER TABLE sessions ADD COLUMN importance_score REAL DEFAULT 0.0',
    'ALTER TABLE messages ADD COLUMN importance REAL DEFAULT 0',
    'ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT \'content\'',
  ];

  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // Indexes on migrated columns (must run after ALTER TABLE)
  const postMigrationIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_sessions_importance ON sessions(importance_score)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_outcome ON sessions(outcome)',
    'CREATE INDEX IF NOT EXISTS idx_messages_importance ON messages(importance)',
  ];
  for (const sql of postMigrationIndexes) {
    try { db.exec(sql); } catch { /* already exists */ }
  }

  return db;
}
