# past-conversations-mcp

MCP server that indexes and searches all your Claude Code conversation history, providing knowledge transfer across sessions with distilled intelligence.

## What it does

Indexes all your Claude Code sessions and extracts structured knowledge:

- **Turn-based conversation model** — Groups JSONL records into logical turns (user prompt → assistant response cycle), tracking tool results, errors, commits, and user feedback per turn. This structural context drives all downstream analysis.
- **Message scoring** — Every message is scored for importance (0-1) and typed (conclusion, solution, exploration, error_report, question). Scoring uses structural signals (pre-commit position, error→fix resolution, user confirmation) as primary factors, with content patterns as tiebreakers.
- **Decision extraction** — Detects generalizable principles ("don't X when Y", "chose X because Z") validated by structural gates: user confrontation before, action taken after, user confirmation, or proximity to commits. Eliminates debugging noise that contains decision-like words.
- **Error-fix detection** — Structurally proven: identifies turns where tool results had errors, then finds the resolution turn where tools succeeded. No regex needed for detection — structure proves causality.
- **Session outcomes** — Computes whether sessions ended successfully, partially, with errors, or were abandoned.
- **Cross-project references** — Detects when one project references another (filesystem paths, "copied from X project").
- **Structural tagging** — Tags sessions by what tools were used, what files were touched, and what commands were run — not by content keywords. `testing` requires actual test files or test runner commands, not the word "test" in text.
- **Importance ranking** — Sessions scored by commits, file breadth, outcome, and cross-references.
- **NLP text analysis** — Uses [compromise](https://github.com/spencermountain/compromise) for sentence boundary detection and [wink-sentiment](https://github.com/winkjs/wink-sentiment) (AFINN-165 lexicon) for user feedback classification. Both deterministic, pure JS, no native deps.

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

Restart Claude Code. First startup takes ~17s to build the index. Subsequent startups are <700ms (incremental).

### From source

```bash
git clone https://github.com/artpar/past-conversations-mcp
cd past-conversations-mcp
npm install
npm run build
node dist/index.js
```

## Tools (11)

### Knowledge tools

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
│   ├── jsonl.ts             Turn-based JSONL parsing with structural enrichment
│   ├── history.ts           history.jsonl streaming
│   ├── project.ts           Project/session discovery
│   ├── subagent.ts          Subagent file parsing
│   └── extractor.ts         Principle detection + structural tag extraction
├── tools/
│   ├── search.ts            search_conversations, search_history
│   ├── sessions.ts          list_sessions, get_session, get_session_context
│   ├── projects.ts          list_projects, get_project_memory
│   ├── insights.ts          search_insights, search_by_context, get_project_knowledge
│   └── admin.ts             rebuild_index
└── utils/
    ├── paths.ts             Path/slug utilities
    ├── text.ts              Text extraction helpers
    ├── nlp.ts               NLP utilities (compromise + wink-sentiment)
    └── scoring.ts           Turn-based importance scoring
```

### Extraction pipeline

```
JSONL records
  → Group by message.id into logical messages
  → Pair user prompts with assistant responses into turns
  → Track tool result errors/successes per turn
  → Classify user feedback via sentiment analysis
  → Build errorFixPairs (structural error→resolution sequences)
  → Build commitTurnIndices (turns containing git commits)
  → Score turns using structural context (pre-commit, error-fix, user confirmation)
  → Extract decisions via principle patterns + structural validation gates
  → Extract error-fixes from structural pairs (no regex for detection)
  → Compute structural tags from tool usage, file paths, bash commands
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

- **Full build**: ~17s for ~1700 sessions on a typical machine
- **Incremental**: <700ms (mtime-based, only re-indexes changed files)
- Index stored at `~/.claude/past-conversations-index.db`

## Key design choices

- **Turn-based model over flat messages** — Conversations are trees of records linked by parentUuid. Grouping into turns captures tool result context, user feedback, and stop_reason that flat message lists lose.
- **Structural signals over content patterns** — Scoring and extraction use conversation structure (what happened before/after, did tools succeed, did user confirm) as primary signals. Content regex patterns are tiebreakers, not drivers.
- **Principle detection over keyword matching** — Decision extraction requires co-occurrence of a directive AND scope/rationale in the same text, plus at least one structural validation gate. Eliminates debugging traces that contain decision-like words.
- **Structural tags over content keywords** — Tags derived from what tools were used and what files were touched, not from keywords in text. "testing" requires test files or test runner commands.
- **sql.js over better-sqlite3** — Pure WASM avoids native module ABI mismatches when Claude Code (Bun-based) spawns MCP servers
- **FTS4 over FTS5** — sql.js doesn't ship FTS5; standalone FTS4 tables (not content-linked) avoid transaction conflicts
- **NLP for text analysis** — compromise for sentence boundaries (handles abbreviations, code, URLs), wink-sentiment for user feedback classification (AFINN-165 lexicon). Both deterministic and pure JS.
- **Connect before index** — MCP stdio transport connects immediately; incremental indexing runs in background

## Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `@modelcontextprotocol/sdk` | MCP server protocol | — |
| `sql.js` | SQLite via WASM | — |
| `zod` | Schema validation | — |
| `compromise` | Sentence splitting, POS tagging | 2.6 MB |
| `wink-sentiment` | AFINN-165 sentiment analysis | 332 KB |

## License

MIT
