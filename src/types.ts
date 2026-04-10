// ---- Raw JSONL record types ----

export interface RawRecord {
  type: string;
  parentUuid?: string;
  isSidechain?: boolean;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  version?: string;
  userType?: string;
  entrypoint?: string;
  message?: RawMessage;
  // system record fields
  subtype?: string;
  durationMs?: number;
  // custom-title
  customTitle?: string;
  // last-prompt
  lastPrompt?: string;
  // agent-name
  agentName?: string;
  // queue-operation
  operation?: string;
  content?: string;
  // progress
  data?: unknown;
  parentToolUseID?: string;
  toolUseID?: string;
  // file-history-snapshot
  snapshot?: unknown;
  isSnapshotUpdate?: boolean;
  messageId?: string;
  // prompt metadata
  promptId?: string;
  permissionMode?: string;
  requestId?: string;
}

export interface RawMessage {
  role: string;
  content: string | RawContentBlock[];
  model?: string;
  id?: string;
  type?: string;
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
}

export type RawContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; caller?: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | RawContentBlock[]; is_error?: boolean }
  | { type: "image"; source?: unknown };

// ---- History JSONL ----

export interface HistoryEntry {
  display: string;
  pastedContents?: Record<string, unknown>;
  timestamp: number;
  project: string;
  sessionId: string;
}

// ---- Indexed data ----

export interface SessionInfo {
  session_id: string;
  project_slug: string;
  project_path: string;
  slug: string | null;
  custom_title: string | null;
  first_prompt: string | null;
  started_at: string | null;
  last_activity: string | null;
  git_branch: string | null;
  has_full_transcript: number;
  message_count: number;
}

export interface MessageRecord {
  id: number;
  session_id: string;
  role: string;
  content: string;
  timestamp: string | null;
  message_index: number;
}

export interface ToolUsageRecord {
  id: number;
  session_id: string;
  tool_name: string;
  file_path: string | null;
  timestamp: string | null;
}

export interface HistoryRecord {
  id: number;
  session_id: string;
  project_path: string;
  display: string;
  timestamp: number;
}

// ---- API response types ----

export interface SearchResult {
  text: string;
  role: string;
  session_id: string;
  project: string;
  slug: string | null;
}

export interface SessionListItem {
  session_id: string;
  project: string;
  slug: string | null;
  title: string | null;
  started_at: string | null;
  last_activity: string | null;
  message_count: number;
  has_full_transcript: boolean;
  outcome?: string | null;
  importance_score?: number | null;
}

export interface SessionMessage {
  role: string;
  text: string;
  timestamp: string | null;
  tool_name?: string;
  tool_input_summary?: string;
}

export interface SessionContext {
  title: string | null;
  project: string;
  slug: string | null;
  date_range: { start: string | null; end: string | null };
  user_prompts: string[];
  assistant_summaries: string[];
  tools_used: Record<string, number>;
  files_touched: string[];
  subagent_count: number;
  git_branch: string | null;
  outcome: string | null;
  importance_score: number | null;
  insights: InsightInfo[];
  tags: string[];
  cross_references: CrossRefInfo[];
}

export interface ProjectInfo {
  project_path: string;
  slug: string;
  session_count: number;
  total_prompts: number;
  date_range: { start: string | null; end: string | null };
  memory_files: string[];
  top_tags: Array<{ tag: string; count: number }>;
  decision_count: number;
  cross_ref_count: number;
  avg_importance: number;
}

export interface HistorySearchResult {
  display: string;
  session_id: string;
  project: string;
}

export interface IndexStats {
  sessions: number;
  messages: number;
  history_entries: number;
  tool_usages: number;
  insights: number;
  duration_ms: number;
}

// ---- Insight types ----

export interface InsightInfo {
  id: number;
  session_id: string;
  insight_type: string;
  summary: string;
  detail: string | null;
  confidence: number;
  source_index: number | null;
  // Joined from sessions
  project?: string;
  session_title?: string;
  started_at?: string;
}

export interface CrossRefInfo {
  source_session_id: string;
  source_project: string;
  target_project: string;
  reference_type: string;
  context: string | null;
}

export interface ProjectKnowledge {
  memory_files: Array<{ filename: string; content: string }>;
  decisions: InsightInfo[];
  cross_references: { inbound: CrossRefInfo[]; outbound: CrossRefInfo[] };
  recent_sessions: SessionListItem[];
  top_tags: Array<{ tag: string; count: number }>;
}

export interface SearchResultWithContext {
  session_id: string;
  project: string;
  slug: string | null;
  session_title: string | null;
  match: {
    text: string;
    role: string;
    importance: number;
    message_type: string;
    message_index: number;
  };
  context_before: Array<{ role: string; text: string; message_index: number }>;
  context_after: Array<{ role: string; text: string; message_index: number }>;
  score: number;
}

export interface ContextSearchResult {
  session_id: string;
  project: string;
  slug: string | null;
  title: string | null;
  started_at: string | null;
  last_activity: string | null;
  message_count: number;
  outcome: string | null;
  tools_matched: string | null;
  files_matched: string | null;
}
