import { Database } from "./Database.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { slugToPath } from "../utils/paths.js";
import { PROJECTS_DIR } from "../utils/paths.js";
import { streamJsonl } from "../parser/jsonl.js";
import { listSubagentFiles } from "../parser/project.js";
import type {
  SearchResult,
  SessionListItem,
  SessionMessage,
  SessionContext,
  ProjectInfo,
  HistorySearchResult,
  InsightInfo,
  CrossRefInfo,
  ProjectKnowledge,
  SearchResultWithContext,
  ContextSearchResult,
} from "../types.js";

// ---- search_conversations (enhanced with importance ranking + context) ----

export function searchConversations(
  db: Database,
  params: {
    query: string;
    project?: string;
    date_from?: string;
    date_to?: string;
    role?: string;
    limit?: number;
    min_importance?: number;
    message_type?: string;
    context_messages?: number;
    group_by_session?: boolean;
  }
): SearchResultWithContext[] | SearchResult[] {
  const limit = Math.min(params.limit ?? 20, 100);
  const minImportance = params.min_importance ?? 0;
  const contextMessages = params.context_messages ?? 0;
  const groupBySession = params.group_by_session ?? (contextMessages > 0);

  // Over-fetch for ranking
  const overFetchLimit = limit * 3;

  let sql = `
    SELECT
      f.content AS text,
      f.role,
      f.session_id,
      f.message_index,
      s.project_path AS project,
      s.slug,
      COALESCE(s.custom_title, s.first_prompt) AS session_title,
      s.last_activity,
      s.importance_score AS session_importance
    FROM messages_fts f
    JOIN sessions s ON s.session_id = f.session_id
    WHERE messages_fts MATCH ?
  `;
  const bindParams: unknown[] = [params.query];

  if (params.project) {
    sql += ` AND s.project_path LIKE ?`;
    bindParams.push(`%${params.project}%`);
  }
  if (params.role && params.role !== "any") {
    sql += ` AND f.role = ?`;
    bindParams.push(params.role);
  }
  if (params.date_from) {
    sql += ` AND s.started_at >= ?`;
    bindParams.push(params.date_from);
  }
  if (params.date_to) {
    sql += ` AND s.started_at <= ?`;
    bindParams.push(params.date_to);
  }

  sql += ` LIMIT ?`;
  bindParams.push(overFetchLimit);

  const ftsRows = db.prepare(sql).all(...bindParams) as Array<{
    text: string;
    role: string;
    session_id: string;
    message_index: string;
    project: string;
    slug: string | null;
    session_title: string | null;
    last_activity: string | null;
    session_importance: number | null;
  }>;

  // Enrich with message-level importance
  type EnrichedRow = typeof ftsRows[0] & { importance: number; message_type: string; score: number };
  const enriched: EnrichedRow[] = [];

  for (const row of ftsRows) {
    const msgIdx = parseInt(row.message_index, 10);
    const msgInfo = db.prepare(
      `SELECT importance, message_type FROM messages WHERE session_id = ? AND message_index = ?`
    ).get(row.session_id, msgIdx) as { importance: number; message_type: string } | undefined;

    const importance = msgInfo?.importance ?? 0.3;
    const messageType = msgInfo?.message_type ?? 'content';

    if (importance < minImportance) continue;
    if (params.message_type && params.message_type !== 'any' && messageType !== params.message_type) continue;

    // Composite score
    const recencyBoost = row.last_activity
      ? 1 / (1 + (Date.now() - new Date(row.last_activity).getTime()) / (86400000 * 30))
      : 0;
    const roleBoost = row.role === 'assistant' ? 0.1 : 0;
    const score = importance * 0.5 + (row.session_importance ?? 0) * 0.2 + recencyBoost * 0.2 + roleBoost;

    enriched.push({ ...row, importance, message_type: messageType, score });
  }

  // Sort by score
  enriched.sort((a, b) => b.score - a.score);

  // If no context or grouping requested, return simple results
  if (contextMessages === 0 && !groupBySession) {
    return enriched.slice(0, limit).map(r => ({
      text: r.text,
      role: r.role,
      session_id: r.session_id,
      project: r.project,
      slug: r.slug,
    }));
  }

  // Group by session: keep best match per session
  let results: EnrichedRow[];
  if (groupBySession) {
    const seen = new Set<string>();
    results = [];
    for (const row of enriched) {
      if (!seen.has(row.session_id)) {
        seen.add(row.session_id);
        results.push(row);
      }
      if (results.length >= limit) break;
    }
  } else {
    results = enriched.slice(0, limit);
  }

  // Fetch context messages
  return results.map(row => {
    const msgIdx = parseInt(row.message_index, 10);
    const contextBefore: Array<{ role: string; text: string; message_index: number }> = [];
    const contextAfter: Array<{ role: string; text: string; message_index: number }> = [];

    if (contextMessages > 0) {
      const before = db.prepare(
        `SELECT role, content AS text, message_index FROM messages
         WHERE session_id = ? AND message_index < ? AND message_index >= ?
         ORDER BY message_index`
      ).all(row.session_id, msgIdx, msgIdx - contextMessages) as Array<{ role: string; text: string; message_index: number }>;
      contextBefore.push(...before);

      const after = db.prepare(
        `SELECT role, content AS text, message_index FROM messages
         WHERE session_id = ? AND message_index > ? AND message_index <= ?
         ORDER BY message_index`
      ).all(row.session_id, msgIdx, msgIdx + contextMessages) as Array<{ role: string; text: string; message_index: number }>;
      contextAfter.push(...after);
    }

    return {
      session_id: row.session_id,
      project: row.project,
      slug: row.slug,
      session_title: row.session_title,
      match: {
        text: row.text,
        role: row.role,
        importance: row.importance,
        message_type: row.message_type,
        message_index: msgIdx,
      },
      context_before: contextBefore,
      context_after: contextAfter,
      score: row.score,
    };
  });
}

// ---- search_history ----

export function searchHistory(
  db: Database,
  params: {
    query: string;
    project?: string;
    limit?: number;
  }
): HistorySearchResult[] {
  const limit = Math.min(params.limit ?? 30, 100);

  let sql = `
    SELECT
      display,
      session_id,
      project_path AS project
    FROM history_fts
    WHERE history_fts MATCH ?
  `;
  const bindParams: unknown[] = [params.query];

  if (params.project) {
    sql += ` AND project_path LIKE ?`;
    bindParams.push(`%${params.project}%`);
  }

  sql += ` LIMIT ?`;
  bindParams.push(limit);

  return db.prepare(sql).all(...bindParams) as HistorySearchResult[];
}

// ---- search_insights ----

export function searchInsights(
  db: Database,
  params: {
    query: string;
    type?: string;
    project?: string;
    min_confidence?: number;
    limit?: number;
  }
): InsightInfo[] {
  const limit = Math.min(params.limit ?? 20, 100);
  const minConfidence = params.min_confidence ?? 0;

  let sql = `
    SELECT
      i.id, i.session_id, i.insight_type, i.summary, i.detail,
      i.confidence, i.source_index,
      s.project_path AS project,
      COALESCE(s.custom_title, s.first_prompt) AS session_title,
      s.started_at
    FROM insights_fts f
    JOIN session_insights i ON i.session_id = f.session_id AND i.insight_type = f.insight_type AND i.summary = f.summary
    JOIN sessions s ON s.session_id = i.session_id
    WHERE insights_fts MATCH ?
    AND i.confidence >= ?
  `;
  const bindParams: unknown[] = [params.query, minConfidence];

  if (params.type) {
    sql += ` AND i.insight_type = ?`;
    bindParams.push(params.type);
  }
  if (params.project) {
    sql += ` AND s.project_path LIKE ?`;
    bindParams.push(`%${params.project}%`);
  }

  sql += ` ORDER BY i.confidence DESC LIMIT ?`;
  bindParams.push(limit);

  return db.prepare(sql).all(...bindParams) as InsightInfo[];
}

// ---- search_by_context ----

export function searchByContext(
  db: Database,
  params: {
    file_path?: string;
    tool_name?: string;
    project?: string;
    date_from?: string;
    date_to?: string;
    outcome?: string;
    tags?: string[];
    limit?: number;
  }
): ContextSearchResult[] {
  const limit = Math.min(params.limit ?? 20, 50);

  let sql = `
    SELECT DISTINCT
      s.session_id,
      s.project_path AS project,
      s.slug,
      COALESCE(s.custom_title, s.first_prompt) AS title,
      s.started_at,
      s.last_activity,
      s.message_count,
      s.outcome
  `;

  let hasToolJoin = false;
  if (params.file_path || params.tool_name) {
    sql += `,
      GROUP_CONCAT(DISTINCT tu.tool_name) AS tools_matched,
      GROUP_CONCAT(DISTINCT tu.file_path) AS files_matched
    `;
    hasToolJoin = true;
  } else {
    sql += `, NULL AS tools_matched, NULL AS files_matched`;
  }

  sql += ` FROM sessions s`;
  if (hasToolJoin) {
    sql += ` JOIN tool_usage tu ON tu.session_id = s.session_id`;
  }

  const conditions: string[] = ['1=1'];
  const bindParams: unknown[] = [];

  if (params.file_path) {
    conditions.push(`tu.file_path LIKE ?`);
    bindParams.push(`%${params.file_path}%`);
  }
  if (params.tool_name) {
    conditions.push(`tu.tool_name = ?`);
    bindParams.push(params.tool_name);
  }
  if (params.project) {
    conditions.push(`s.project_path LIKE ?`);
    bindParams.push(`%${params.project}%`);
  }
  if (params.date_from) {
    conditions.push(`s.started_at >= ?`);
    bindParams.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push(`s.started_at <= ?`);
    bindParams.push(params.date_to);
  }
  if (params.outcome) {
    conditions.push(`s.outcome = ?`);
    bindParams.push(params.outcome);
  }
  if (params.tags && params.tags.length > 0) {
    for (const tag of params.tags) {
      conditions.push(`s.session_id IN (SELECT session_id FROM session_tags WHERE tag = ?)`);
      bindParams.push(tag);
    }
  }

  sql += ` WHERE ${conditions.join(' AND ')}`;
  if (hasToolJoin) {
    sql += ` GROUP BY s.session_id`;
  }
  sql += ` ORDER BY s.last_activity DESC LIMIT ?`;
  bindParams.push(limit);

  return db.prepare(sql).all(...bindParams) as ContextSearchResult[];
}

// ---- list_sessions (enhanced) ----

export function listSessions(
  db: Database,
  params: {
    project?: string;
    query?: string;
    date_from?: string;
    date_to?: string;
    sort?: string;
    limit?: number;
    outcome?: string;
    min_importance?: number;
    tags?: string[];
  }
): SessionListItem[] {
  const limit = Math.min(params.limit ?? 30, 200);
  const sortCol = params.sort === "importance" ? "s.importance_score" : "s.last_activity";
  const sortDir = params.sort === "oldest" ? "ASC" : "DESC";

  let sql = `
    SELECT
      s.session_id,
      s.project_path AS project,
      s.slug,
      COALESCE(s.custom_title, s.first_prompt) AS title,
      s.started_at,
      s.last_activity,
      s.message_count,
      s.has_full_transcript,
      s.outcome,
      s.importance_score
    FROM sessions s
    WHERE 1=1
  `;
  const bindParams: unknown[] = [];

  if (params.project) {
    sql += ` AND s.project_path LIKE ?`;
    bindParams.push(`%${params.project}%`);
  }
  if (params.query) {
    sql += ` AND (s.custom_title LIKE ? OR s.first_prompt LIKE ?)`;
    bindParams.push(`%${params.query}%`, `%${params.query}%`);
  }
  if (params.date_from) {
    sql += ` AND s.started_at >= ?`;
    bindParams.push(params.date_from);
  }
  if (params.date_to) {
    sql += ` AND s.started_at <= ?`;
    bindParams.push(params.date_to);
  }
  if (params.outcome) {
    sql += ` AND s.outcome = ?`;
    bindParams.push(params.outcome);
  }
  if (params.min_importance != null) {
    sql += ` AND s.importance_score >= ?`;
    bindParams.push(params.min_importance);
  }
  if (params.tags && params.tags.length > 0) {
    for (const tag of params.tags) {
      sql += ` AND s.session_id IN (SELECT session_id FROM session_tags WHERE tag = ?)`;
      bindParams.push(tag);
    }
  }

  sql += ` ORDER BY ${sortCol} ${sortDir} LIMIT ?`;
  bindParams.push(limit);

  const rows = db.prepare(sql).all(...bindParams) as Array<{
    session_id: string;
    project: string;
    slug: string | null;
    title: string | null;
    started_at: string | null;
    last_activity: string | null;
    message_count: number;
    has_full_transcript: number;
    outcome: string | null;
    importance_score: number | null;
  }>;

  return rows.map((r) => ({
    ...r,
    has_full_transcript: r.has_full_transcript === 1,
  }));
}

// ---- get_session ----

export function getSession(
  db: Database,
  params: {
    session_id: string;
    include?: string;
    offset?: number;
    limit?: number;
  }
): { metadata: SessionListItem | null; messages: SessionMessage[] } {
  const offset = params.offset ?? 0;
  const limit = Math.min(params.limit ?? 100, 500);

  const session = db.prepare(`
    SELECT
      session_id,
      project_path AS project,
      slug,
      COALESCE(custom_title, first_prompt) AS title,
      started_at,
      last_activity,
      message_count,
      has_full_transcript,
      outcome,
      importance_score
    FROM sessions WHERE session_id = ?
  `).get(params.session_id) as {
    session_id: string;
    project: string;
    slug: string | null;
    title: string | null;
    started_at: string | null;
    last_activity: string | null;
    message_count: number;
    has_full_transcript: number;
    outcome: string | null;
    importance_score: number | null;
  } | undefined;

  if (!session) {
    return { metadata: null, messages: [] };
  }

  const metadata: SessionListItem = {
    ...session,
    has_full_transcript: session.has_full_transcript === 1,
  };

  if (params.include === "all") {
    return { metadata, messages: getFullSessionMessages(db, params.session_id, offset, limit) };
  }

  const messages = db.prepare(`
    SELECT role, content AS text, timestamp
    FROM messages
    WHERE session_id = ?
    ORDER BY message_index
    LIMIT ? OFFSET ?
  `).all(params.session_id, limit, offset) as SessionMessage[];

  return { metadata, messages };
}

function getFullSessionMessages(
  db: Database,
  sessionId: string,
  offset: number,
  limit: number
): SessionMessage[] {
  const session = db.prepare(`SELECT project_slug FROM sessions WHERE session_id = ?`).get(sessionId) as { project_slug: string } | undefined;
  if (!session) return [];

  const jsonlPath = join(PROJECTS_DIR, session.project_slug, sessionId + ".jsonl");
  if (!existsSync(jsonlPath)) {
    return db.prepare(`
      SELECT role, content AS text, timestamp
      FROM messages WHERE session_id = ?
      ORDER BY message_index LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset) as SessionMessage[];
  }

  const messages: SessionMessage[] = [];
  const lines = readFileSync(jsonlPath, "utf-8").split("\n");
  let idx = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);

      if (record.type === "user" && record.message) {
        const content = record.message.content;
        if (typeof content === "string" && content.trim()) {
          if (idx >= offset && messages.length < limit) {
            messages.push({
              role: "user",
              text: content,
              timestamp: record.timestamp ?? null,
            });
          }
          idx++;
        }
      } else if (record.type === "assistant" && record.message) {
        const content = record.message.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            if (idx >= offset && messages.length < limit) {
              messages.push({
                role: "assistant",
                text: block.text,
                timestamp: record.timestamp ?? null,
              });
            }
            idx++;
          } else if (block.type === "tool_use") {
            if (idx >= offset && messages.length < limit) {
              const inputStr = JSON.stringify(block.input);
              messages.push({
                role: "assistant",
                text: "",
                timestamp: record.timestamp ?? null,
                tool_name: block.name,
                tool_input_summary: inputStr.length > 200 ? inputStr.slice(0, 200) + "..." : inputStr,
              });
            }
            idx++;
          }
        }
      }
    } catch {
      // skip
    }
  }

  return messages;
}

// ---- get_session_context (enhanced with insights, tags, cross-refs) ----

export function getSessionContext(
  db: Database,
  sessionId: string
): SessionContext | null {
  const session = db.prepare(`
    SELECT session_id, project_path, slug, custom_title, first_prompt,
           started_at, last_activity, git_branch, has_full_transcript,
           outcome, importance_score
    FROM sessions WHERE session_id = ?
  `).get(sessionId) as {
    session_id: string;
    project_path: string;
    slug: string | null;
    custom_title: string | null;
    first_prompt: string | null;
    started_at: string | null;
    last_activity: string | null;
    git_branch: string | null;
    has_full_transcript: number;
    outcome: string | null;
    importance_score: number | null;
  } | undefined;

  if (!session) return null;

  const userMessages = db.prepare(`
    SELECT content FROM messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY message_index
  `).all(sessionId) as Array<{ content: string }>;

  const assistantMessages = db.prepare(`
    SELECT content FROM messages
    WHERE session_id = ? AND role = 'assistant'
    ORDER BY message_index
  `).all(sessionId) as Array<{ content: string }>;

  const toolUsage = db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM tool_usage WHERE session_id = ?
    GROUP BY tool_name ORDER BY count DESC
  `).all(sessionId) as Array<{ tool_name: string; count: number }>;

  const toolsUsed: Record<string, number> = {};
  for (const tu of toolUsage) {
    toolsUsed[tu.tool_name] = tu.count;
  }

  const files = db.prepare(`
    SELECT DISTINCT file_path FROM tool_usage
    WHERE session_id = ? AND file_path IS NOT NULL
    ORDER BY file_path
  `).all(sessionId) as Array<{ file_path: string }>;

  // Count subagents
  let subagentCount = 0;
  const projectSlug = db.prepare(`SELECT project_slug FROM sessions WHERE session_id = ?`).get(sessionId) as { project_slug: string } | undefined;
  if (projectSlug) {
    const sessionDir = join(PROJECTS_DIR, projectSlug.project_slug, sessionId);
    if (existsSync(sessionDir)) {
      subagentCount = listSubagentFiles(sessionDir).length;
    }
  }

  // Get insights
  const insights = db.prepare(`
    SELECT id, session_id, insight_type, summary, detail, confidence, source_index
    FROM session_insights WHERE session_id = ?
    ORDER BY confidence DESC
  `).all(sessionId) as InsightInfo[];

  // Get tags
  const tags = db.prepare(`
    SELECT tag FROM session_tags WHERE session_id = ?
  `).all(sessionId) as Array<{ tag: string }>;

  // Get cross-references
  const crossRefs = db.prepare(`
    SELECT source_session_id, source_project, target_project, reference_type, context
    FROM cross_references WHERE source_session_id = ?
  `).all(sessionId) as CrossRefInfo[];

  return {
    title: session.custom_title ?? session.first_prompt,
    project: session.project_path,
    slug: session.slug,
    date_range: { start: session.started_at, end: session.last_activity },
    user_prompts: userMessages.map((m) => m.content),
    assistant_summaries: assistantMessages.map((m) => m.content),
    tools_used: toolsUsed,
    files_touched: files.map((f) => f.file_path),
    subagent_count: subagentCount,
    git_branch: session.git_branch,
    outcome: session.outcome,
    importance_score: session.importance_score,
    insights,
    tags: tags.map(t => t.tag),
    cross_references: crossRefs,
  };
}

// ---- list_projects (enhanced) ----

export function listProjects(db: Database): ProjectInfo[] {
  const rows = db.prepare(`
    SELECT
      project_slug AS slug,
      project_path,
      COUNT(DISTINCT session_id) AS session_count,
      MIN(started_at) AS first_activity,
      MAX(last_activity) AS last_activity,
      AVG(importance_score) AS avg_importance
    FROM sessions
    GROUP BY project_slug
    ORDER BY last_activity DESC
  `).all() as Array<{
    slug: string;
    project_path: string;
    session_count: number;
    first_activity: string | null;
    last_activity: string | null;
    avg_importance: number | null;
  }>;

  const promptCounts = db.prepare(`
    SELECT project_path, COUNT(*) AS count
    FROM history GROUP BY project_path
  `).all() as Array<{ project_path: string; count: number }>;

  const promptMap = new Map<string, number>();
  for (const pc of promptCounts) {
    promptMap.set(pc.project_path, pc.count);
  }

  return rows.map((r) => {
    // Find memory files
    const memoryDir = join(PROJECTS_DIR, r.slug, "memory");
    let memoryFiles: string[] = [];
    if (existsSync(memoryDir)) {
      try {
        memoryFiles = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
      } catch {
        // ignore
      }
    }

    // Get top tags for this project
    const topTags = db.prepare(`
      SELECT t.tag, COUNT(*) as count
      FROM session_tags t
      JOIN sessions s ON s.session_id = t.session_id
      WHERE s.project_slug = ?
      GROUP BY t.tag
      ORDER BY count DESC
      LIMIT 10
    `).all(r.slug) as Array<{ tag: string; count: number }>;

    // Count decisions
    const decisionCount = (db.prepare(`
      SELECT COUNT(*) as count FROM session_insights i
      JOIN sessions s ON s.session_id = i.session_id
      WHERE s.project_slug = ? AND i.insight_type = 'decision'
    `).get(r.slug) as { count: number }).count;

    // Count cross-references
    const crossRefCount = (db.prepare(`
      SELECT COUNT(*) as count FROM cross_references
      WHERE source_project = ? OR target_project = ?
    `).get(r.project_path, r.project_path) as { count: number }).count;

    return {
      project_path: r.project_path ?? slugToPath(r.slug),
      slug: r.slug,
      session_count: r.session_count,
      total_prompts: promptMap.get(r.project_path) ?? 0,
      date_range: { start: r.first_activity, end: r.last_activity },
      memory_files: memoryFiles,
      top_tags: topTags,
      decision_count: decisionCount,
      cross_ref_count: crossRefCount,
      avg_importance: Math.round((r.avg_importance ?? 0) * 100) / 100,
    };
  });
}

// ---- get_project_memory ----

export function getProjectMemory(
  db: Database,
  projectQuery: string
): Array<{ filename: string; content: string }> {
  const session = db.prepare(`
    SELECT DISTINCT project_slug FROM sessions
    WHERE project_path LIKE ? OR project_slug LIKE ?
    LIMIT 1
  `).get(`%${projectQuery}%`, `%${projectQuery}%`) as { project_slug: string } | undefined;

  if (!session) return [];

  const memoryDir = join(PROJECTS_DIR, session.project_slug, "memory");
  if (!existsSync(memoryDir)) return [];

  const results: Array<{ filename: string; content: string }> = [];
  for (const file of readdirSync(memoryDir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = readFileSync(join(memoryDir, file), "utf-8");
      results.push({ filename: file, content });
    } catch {
      // skip unreadable files
    }
  }

  return results;
}

// ---- get_project_knowledge ----

export function getProjectKnowledge(
  db: Database,
  params: {
    project: string;
    include?: string[];
  }
): ProjectKnowledge {
  const include = params.include ?? ['memory', 'decisions', 'cross_refs', 'recent_sessions', 'tags'];

  const result: ProjectKnowledge = {
    memory_files: [],
    decisions: [],
    cross_references: { inbound: [], outbound: [] },
    recent_sessions: [],
    top_tags: [],
  };

  // Find the project
  const projRow = db.prepare(`
    SELECT DISTINCT project_slug, project_path FROM sessions
    WHERE project_path LIKE ? OR project_slug LIKE ?
    LIMIT 1
  `).get(`%${params.project}%`, `%${params.project}%`) as { project_slug: string; project_path: string } | undefined;

  if (!projRow) return result;

  if (include.includes('memory')) {
    result.memory_files = getProjectMemory(db, params.project);
  }

  if (include.includes('decisions')) {
    result.decisions = db.prepare(`
      SELECT i.id, i.session_id, i.insight_type, i.summary, i.detail, i.confidence, i.source_index,
             s.project_path AS project,
             COALESCE(s.custom_title, s.first_prompt) AS session_title,
             s.started_at
      FROM session_insights i
      JOIN sessions s ON s.session_id = i.session_id
      WHERE s.project_slug = ? AND i.insight_type = 'decision' AND i.confidence >= 0.5
      ORDER BY s.started_at DESC
    `).all(projRow.project_slug) as InsightInfo[];
  }

  if (include.includes('cross_refs')) {
    result.cross_references.outbound = db.prepare(`
      SELECT source_session_id, source_project, target_project, reference_type, context
      FROM cross_references WHERE source_project = ?
    `).all(projRow.project_path) as CrossRefInfo[];

    result.cross_references.inbound = db.prepare(`
      SELECT source_session_id, source_project, target_project, reference_type, context
      FROM cross_references WHERE target_project = ?
    `).all(projRow.project_path) as CrossRefInfo[];
  }

  if (include.includes('recent_sessions')) {
    result.recent_sessions = listSessions(db, {
      project: params.project,
      limit: 10,
      sort: 'recent',
    });
  }

  if (include.includes('tags')) {
    result.top_tags = db.prepare(`
      SELECT t.tag, COUNT(*) as count
      FROM session_tags t
      JOIN sessions s ON s.session_id = t.session_id
      WHERE s.project_slug = ?
      GROUP BY t.tag ORDER BY count DESC LIMIT 20
    `).all(projRow.project_slug) as Array<{ tag: string; count: number }>;
  }

  return result;
}
