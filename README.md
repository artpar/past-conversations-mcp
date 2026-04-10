# past-conversations-mcp

MCP server that indexes and searches all your Claude Code conversation history, providing knowledge transfer across sessions with distilled intelligence.

## What it does

Indexes all your Claude Code sessions and extracts structured knowledge:

- **Message scoring** — Every message is scored for importance (0-1) and typed (conclusion, solution, exploration, error_report, question). Search prioritizes conclusions over debugging noise.
- **Decision extraction** — Automatically detects decisions with rationale from conversation patterns ("chose X because Y", "switched to X", "the fix is").
- **Session outcomes** — Computes whether sessions ended successfully, partially, with errors, or were abandoned.
- **Cross-project references** — Detects when one project references another (filesystem paths, "copied from X project").
- **Auto-tagging** — Tags sessions by language (typescript, golang, python), activity (refactoring, bugfix, testing, devops), and domain (api, database, frontend).
- **Importance ranking** — Sessions scored by commits, file breadth, outcome, and cross-references.

## Installation

### As a global MCP server for Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "past-conversations": {
      "command": "npx",
      "args": ["-y", "past-conversations-mcp"]
    }
  }
}
```

Restart Claude Code. First startup takes ~10s to build the index. Subsequent startups are <700ms (incremental).

### From source

```bash
git clone https://github.com/artpar/past-conversations-mcp
cd past-conversations-mcp
npm install
npm run build
node dist/index.js
```

## Tools (11)

### Knowledge tools (new in v2)

| Tool | Description |
|------|-------------|
| `search_insights` | Search extracted decisions, error fixes, patterns. Returns distilled knowledge, not raw text. |
| `search_by_context` | Find sessions by file path, tool name, outcome, tags, or date range. |
| `get_project_knowledge` | Aggregated KT for a project: memory files, decisions, cross-refs, recent sessions, tags. |

### Search tools

| Tool | Description |
|------|-------------|
| `search_conversations` | Full-text search with importance ranking, message type filtering, context windows, and session grouping. |
| `search_history` | Fast search over all user prompts (covers sessions without full transcripts). |

### Session tools

| Tool | Description |
|------|-------------|
| `list_sessions` | Browse sessions with outcome, importance, and tag filters. Sort by recency or importance. |
| `get_session` | Full conversation transcript with pagination. |
| `get_session_context` | Rich KT context: prompts, responses, files, tools, insights, tags, cross-refs, outcome. |

### Project tools

| Tool | Description |
|------|-------------|
| `list_projects` | All projects with stats, top tags, decision counts, cross-ref counts, avg importance. |
| `get_project_memory` | Read curated memory files (`.claude/projects/*/memory/*.md`). |

### Admin tools

| Tool | Description |
|------|-------------|
| `rebuild_index` | Force complete re-index from scratch. |

## Architecture

```
src/
├── index.ts                 Entry point, MCP server setup
├── types.ts                 All TypeScript interfaces
├── db/
│   ├── Database.ts          sql.js wrapper (better-sqlite3-compatible API)
│   ├── schema.ts            SQLite schema + migrations
│   ├── indexer.ts            Build/incremental index pipeline
│   └── queries.ts           All query functions
├── parser/
│   ├── jsonl.ts             Conversation JSONL parsing + enrichment
│   ├── history.ts           history.jsonl streaming
│   ├── project.ts           Project/session discovery
│   ├── subagent.ts          Subagent file parsing
│   └── extractor.ts         Decision/error-fix/cross-ref/tag extraction
├── tools/
│   ├── search.ts            search_conversations, search_history
│   ├── sessions.ts          list_sessions, get_session, get_session_context
│   ├── projects.ts          list_projects, get_project_memory
│   ├── insights.ts          search_insights, search_by_context, get_project_knowledge
│   └── admin.ts             rebuild_index
└── utils/
    ├── paths.ts             Path/slug utilities
    ├── text.ts              Text extraction helpers
    └── scoring.ts           Message importance scoring heuristics
```

### Database

SQLite via **sql.js** (pure WASM — no native modules, works in any Node/Bun runtime).

**Tables:**
- `sessions` — Session metadata + computed fields (outcome, importance_score, error_count, commit_count)
- `messages` — User/assistant text with importance scores and message types
- `messages_fts` — FTS4 full-text search on messages
- `tool_usage` — Tool calls with file paths
- `history` / `history_fts` — All user prompts from history.jsonl
- `session_insights` / `insights_fts` — Extracted decisions, error fixes, patterns
- `session_tags` — Auto-generated tags per session
- `cross_references` — Cross-project links

### Data sources

- `~/.claude/projects/` — Conversation JSONL files, subagent files, memory files
- `~/.claude/history.jsonl` — All user prompts across all sessions

### Indexing

- **Full build**: ~10s for ~1700 sessions on a typical machine
- **Incremental**: <700ms (mtime-based, only re-indexes changed files)
- Index stored at `~/.claude/past-conversations-index.db`

## Key design choices

- **sql.js over better-sqlite3** — Pure WASM avoids native module ABI mismatches when Claude Code (Bun-based) spawns MCP servers
- **FTS4 over FTS5** — sql.js doesn't ship FTS5; standalone FTS4 tables (not content-linked) avoid transaction conflicts
- **All extraction at index time** — No LLM calls. Decisions, tags, scores computed via regex/heuristic patterns during indexing
- **Connect before index** — MCP stdio transport connects immediately; incremental indexing runs in background

## License

MIT
