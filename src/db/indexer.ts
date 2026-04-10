import { Database } from "./Database.js";
import { statSync } from "fs";
import { dirname } from "path";
import { parseConversationFile } from "../parser/jsonl.js";
import { streamHistory } from "../parser/history.js";
import { discoverProjects, listSubagentFiles } from "../parser/project.js";
import { parseSubagentFile } from "../parser/subagent.js";
import { extractKnowledge } from "../parser/extractor.js";
import { scoreMessage, computeSessionOutcome, computeSessionImportance } from "../utils/scoring.js";
import { slugToPath } from "../utils/paths.js";
import { HISTORY_FILE } from "../utils/paths.js";
import type { IndexStats } from "../types.js";

export async function buildIndex(db: Database): Promise<IndexStats> {
  const startTime = Date.now();
  let sessionsCount = 0;
  let messagesCount = 0;
  let historyCount = 0;
  let toolUsageCount = 0;
  let insightsCount = 0;

  // Prepared statements
  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions
    (session_id, project_slug, project_path, slug, custom_title, first_prompt,
     started_at, last_activity, git_branch, has_full_transcript, message_count, indexed_at,
     outcome, error_count, commit_count, total_tokens, duration_seconds, importance_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (session_id, role, content, timestamp, message_index, importance, message_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMessageFts = db.prepare(`
    INSERT INTO messages_fts (session_id, role, content, message_index)
    VALUES (?, ?, ?, ?)
  `);

  const insertToolUsage = db.prepare(`
    INSERT INTO tool_usage (session_id, tool_name, file_path, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  const insertHistory = db.prepare(`
    INSERT INTO history (session_id, project_path, display, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  const insertHistoryFts = db.prepare(`
    INSERT INTO history_fts (session_id, project_path, display)
    VALUES (?, ?, ?)
  `);

  const insertInsight = db.prepare(`
    INSERT OR IGNORE INTO session_insights (session_id, insight_type, summary, detail, confidence, source_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertInsightFts = db.prepare(`
    INSERT INTO insights_fts (session_id, insight_type, summary, detail)
    VALUES (?, ?, ?, ?)
  `);

  const insertTag = db.prepare(`
    INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)
  `);

  const insertCrossRef = db.prepare(`
    INSERT INTO cross_references (source_session_id, source_project, target_project, reference_type, context, message_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const getMeta = db.prepare(`SELECT value FROM index_meta WHERE key = ?`);
  const setMeta = db.prepare(`INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)`);

  const deleteMessages = db.prepare("DELETE FROM messages WHERE session_id = ?");
  const deleteToolUsage = db.prepare("DELETE FROM tool_usage WHERE session_id = ?");
  const deleteInsights = db.prepare("DELETE FROM session_insights WHERE session_id = ?");
  const deleteInsightsFts = db.prepare("DELETE FROM insights_fts WHERE session_id = ?");
  const deleteTags = db.prepare("DELETE FROM session_tags WHERE session_id = ?");
  const deleteCrossRefs = db.prepare("DELETE FROM cross_references WHERE source_session_id = ?");
  const getIndexedAt = db.prepare(`SELECT indexed_at FROM sessions WHERE session_id = ?`);

  // Check what's already indexed
  const lastHistoryOffset = getMeta.get("history_offset") as { value: string } | undefined;
  const lastHistoryOffsetNum = lastHistoryOffset ? parseInt(lastHistoryOffset.value, 10) : 0;

  const indexedSessions = new Set<string>();
  const existingSessions = db.prepare(`SELECT session_id FROM sessions`).all() as Array<{ session_id: string }>;
  for (const row of existingSessions) {
    indexedSessions.add(row.session_id);
  }

  // ---- Phase 1: Index history.jsonl ----
  console.error("[indexer] Indexing history.jsonl...");
  const historyBatch: Array<{ sessionId: string; project: string; display: string; timestamp: number }> = [];

  for await (const entry of streamHistory(HISTORY_FILE)) {
    historyBatch.push({
      sessionId: entry.sessionId,
      project: entry.project,
      display: entry.display,
      timestamp: entry.timestamp,
    });
  }

  // Insert history in a single transaction
  const insertHistoryBatch = db.transaction((entries: typeof historyBatch) => {
    if (lastHistoryOffsetNum === 0) {
      db.exec("DELETE FROM history");
      db.exec("DELETE FROM history_fts");
    }
    for (const entry of entries) {
      insertHistory.run(entry.sessionId, entry.project, entry.display, entry.timestamp);
      insertHistoryFts.run(entry.sessionId, entry.project, entry.display);
      historyCount++;
    }
  });
  insertHistoryBatch(historyBatch);

  try {
    const historySize = statSync(HISTORY_FILE).size;
    setMeta.run("history_offset", String(historySize));
  } catch {
    // ignore
  }

  console.error(`[indexer] Indexed ${historyCount} history entries`);

  // ---- Phase 2: Discover and index conversation files ----
  console.error("[indexer] Discovering projects...");
  const projects = discoverProjects();
  console.error(`[indexer] Found ${projects.length} projects`);

  // Collect known project paths for cross-reference detection
  const knownProjectPaths = projects.map(p => slugToPath(p.slug));

  const historyBySession = new Map<string, { project: string; display: string; timestamp: number }[]>();
  for (const entry of historyBatch) {
    const existing = historyBySession.get(entry.sessionId) ?? [];
    existing.push(entry);
    historyBySession.set(entry.sessionId, existing);
  }

  // Collect all session data first, then insert in one transaction
  type SessionData = {
    sessionId: string;
    projectSlug: string;
    projectPath: string;
    slug: string | null;
    customTitle: string | null;
    firstPrompt: string | null;
    startedAt: string | null;
    lastActivity: string | null;
    gitBranch: string | null;
    hasFullTranscript: number;
    messageCount: number;
    messages: Array<{ role: string; content: string; timestamp: string | null; messageIndex: number }>;
    toolUses: Array<{ toolName: string; filePath: string | null; timestamp: string | null }>;
    clearExisting: boolean;
    // Enriched fields
    outcome: string | null;
    errorCount: number;
    commitCount: number;
    totalTokens: number;
    durationSeconds: number;
    importanceScore: number;
    // Extraction results
    insights: Array<{ type: string; summary: string; detail: string; confidence: number; sourceIndex: number }>;
    tags: string[];
    crossRefs: Array<{ targetProject: string; type: string; context: string; messageIndex: number }>;
  };

  const sessionsToInsert: SessionData[] = [];

  for (const project of projects) {
    const projectPath = slugToPath(project.slug);

    for (const session of project.sessions) {
      if (indexedSessions.has(session.sessionId)) {
        if (session.jsonlPath) {
          try {
            const fileStat = statSync(session.jsonlPath);
            const sessionRow = getIndexedAt.get(session.sessionId) as { indexed_at: string } | undefined;
            if (sessionRow?.indexed_at) {
              const indexedAt = new Date(sessionRow.indexed_at);
              if (fileStat.mtime <= indexedAt) {
                continue;
              }
            }
          } catch {
            continue;
          }
        } else {
          continue;
        }
      }

      if (session.jsonlPath) {
        try {
          const parsed = parseConversationFile(session.jsonlPath);
          const firstPrompt = parsed.messages.find((m) => m.role === "user")?.content ?? null;

          // Compute outcome
          const outcome = computeSessionOutcome(
            parsed.messages.map(m => ({ role: m.role, content: m.content })),
            parsed.errorCount,
            parsed.commitCount,
          );

          // Extract knowledge
          const extraction = extractKnowledge(parsed, projectPath, knownProjectPaths);

          // Compute unique directories for importance
          const uniqueFiles = new Set(parsed.toolUses.filter(t => t.filePath).map(t => t.filePath!));
          const uniqueDirs = new Set([...uniqueFiles].map(f => dirname(f)));

          const importanceScore = computeSessionImportance({
            commitCount: parsed.commitCount,
            hasCustomTitle: !!parsed.customTitle,
            outcome,
            messageCount: parsed.messages.length,
            uniqueFileCount: uniqueFiles.size,
            uniqueDirCount: uniqueDirs.size,
            hasCrossRefs: extraction.crossRefs.length > 0,
          });

          sessionsToInsert.push({
            sessionId: session.sessionId,
            projectSlug: project.slug,
            projectPath,
            slug: parsed.slug,
            customTitle: parsed.customTitle,
            firstPrompt: firstPrompt ? firstPrompt.slice(0, 500) : null,
            startedAt: parsed.startedAt,
            lastActivity: parsed.lastActivity,
            gitBranch: parsed.gitBranch,
            hasFullTranscript: 1,
            messageCount: parsed.messages.length,
            messages: parsed.messages.map(m => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              messageIndex: m.messageIndex,
            })),
            toolUses: parsed.toolUses.map(tu => ({
              toolName: tu.toolName,
              filePath: tu.filePath,
              timestamp: tu.timestamp,
            })),
            clearExisting: indexedSessions.has(session.sessionId),
            outcome,
            errorCount: parsed.errorCount,
            commitCount: parsed.commitCount,
            totalTokens: parsed.totalTokens,
            durationSeconds: parsed.durationSeconds,
            importanceScore,
            insights: extraction.insights,
            tags: extraction.tags,
            crossRefs: extraction.crossRefs,
          });
        } catch (err) {
          console.error(`[indexer] Error parsing ${session.jsonlPath}: ${err}`);
        }
      } else {
        const historyEntries = historyBySession.get(session.sessionId);
        if (historyEntries && historyEntries.length > 0) {
          const sorted = historyEntries.sort((a, b) => a.timestamp - b.timestamp);
          const firstPrompt = sorted[0].display;
          const startedAt = new Date(sorted[0].timestamp).toISOString();
          const lastActivity = new Date(sorted[sorted.length - 1].timestamp).toISOString();

          const messages: SessionData["messages"] = [];

          if (session.hasSubagents && session.dirPath) {
            try {
              const subagentFiles = listSubagentFiles(session.dirPath);
              let subagentMessageIndex = 0;
              for (const saFile of subagentFiles) {
                const summary = await parseSubagentFile(saFile);
                for (const prompt of summary.userPrompts) {
                  messages.push({ role: "user", content: prompt, timestamp: null, messageIndex: subagentMessageIndex++ });
                }
                for (const text of summary.assistantTexts) {
                  messages.push({ role: "assistant", content: text, timestamp: null, messageIndex: subagentMessageIndex++ });
                }
              }
            } catch (err) {
              console.error(`[indexer] Error parsing subagents for ${session.sessionId}: ${err}`);
            }
          }

          sessionsToInsert.push({
            sessionId: session.sessionId,
            projectSlug: project.slug,
            projectPath,
            slug: null,
            customTitle: null,
            firstPrompt: firstPrompt.slice(0, 500),
            startedAt,
            lastActivity,
            gitBranch: null,
            hasFullTranscript: 0,
            messageCount: messages.length,
            messages,
            toolUses: [],
            clearExisting: false,
            outcome: null,
            errorCount: 0,
            commitCount: 0,
            totalTokens: 0,
            durationSeconds: 0,
            importanceScore: 0,
            insights: [],
            tags: [],
            crossRefs: [],
          });
        }
      }
    }
  }

  // History-only sessions
  const allSessionIds = new Set<string>();
  for (const project of projects) {
    for (const session of project.sessions) {
      allSessionIds.add(session.sessionId);
    }
  }

  const historyOnlySessions = new Map<string, typeof historyBatch>();
  for (const entry of historyBatch) {
    if (!allSessionIds.has(entry.sessionId) && !indexedSessions.has(entry.sessionId)) {
      const existing = historyOnlySessions.get(entry.sessionId) ?? [];
      existing.push(entry);
      historyOnlySessions.set(entry.sessionId, existing);
    }
  }

  for (const [sessionId, entries] of historyOnlySessions) {
    const sorted = entries.sort((a, b) => a.timestamp - b.timestamp);
    const projectPath = sorted[0].project;
    const projectSlug = projectPath.replace(/\//g, "-");

    sessionsToInsert.push({
      sessionId,
      projectSlug,
      projectPath,
      slug: null,
      customTitle: null,
      firstPrompt: sorted[0].display.slice(0, 500),
      startedAt: new Date(sorted[0].timestamp).toISOString(),
      lastActivity: new Date(sorted[sorted.length - 1].timestamp).toISOString(),
      gitBranch: null,
      hasFullTranscript: 0,
      messageCount: 0,
      messages: [],
      toolUses: [],
      clearExisting: false,
      outcome: null,
      errorCount: 0,
      commitCount: 0,
      totalTokens: 0,
      durationSeconds: 0,
      importanceScore: 0,
      insights: [],
      tags: [],
      crossRefs: [],
    });
  }

  // Insert everything in one transaction
  const deleteMessagesFts = db.prepare("DELETE FROM messages_fts WHERE session_id = ?");
  const insertAll = db.transaction((sessions: SessionData[]) => {
    const now = new Date().toISOString();
    for (const s of sessions) {
      if (s.clearExisting) {
        deleteMessages.run(s.sessionId);
        deleteMessagesFts.run(s.sessionId);
        deleteToolUsage.run(s.sessionId);
        deleteInsights.run(s.sessionId);
        deleteInsightsFts.run(s.sessionId);
        deleteTags.run(s.sessionId);
        deleteCrossRefs.run(s.sessionId);
      }

      insertSession.run(
        s.sessionId, s.projectSlug, s.projectPath, s.slug, s.customTitle,
        s.firstPrompt, s.startedAt, s.lastActivity, s.gitBranch,
        s.hasFullTranscript, s.messageCount || s.messages.length, now,
        s.outcome, s.errorCount, s.commitCount, s.totalTokens, s.durationSeconds, s.importanceScore
      );

      // Score and insert messages
      const totalMessages = s.messages.length;
      const lastAssistantIdx = (() => {
        for (let i = s.messages.length - 1; i >= 0; i--) {
          if (s.messages[i].role === 'assistant') return i;
        }
        return -1;
      })();

      for (let i = 0; i < s.messages.length; i++) {
        const msg = s.messages[i];
        const isLastAssistant = i === lastAssistantIdx;
        const { importance, messageType } = scoreMessage(
          msg.content, msg.role, msg.messageIndex, totalMessages, isLastAssistant,
        );
        insertMessage.run(s.sessionId, msg.role, msg.content, msg.timestamp, msg.messageIndex, importance, messageType);
        insertMessageFts.run(s.sessionId, msg.role, msg.content, String(msg.messageIndex));
        messagesCount++;
      }

      for (const tu of s.toolUses) {
        insertToolUsage.run(s.sessionId, tu.toolName, tu.filePath, tu.timestamp);
        toolUsageCount++;
      }

      // Insert insights
      for (const insight of s.insights) {
        insertInsight.run(s.sessionId, insight.type, insight.summary, insight.detail, insight.confidence, insight.sourceIndex);
        insertInsightFts.run(s.sessionId, insight.type, insight.summary, insight.detail ?? '');
        insightsCount++;
      }

      // Insert tags
      for (const tag of s.tags) {
        insertTag.run(s.sessionId, tag);
      }

      // Insert cross-references
      for (const cr of s.crossRefs) {
        insertCrossRef.run(s.sessionId, s.projectPath, cr.targetProject, cr.type, cr.context, cr.messageIndex);
      }

      sessionsCount++;
    }
  });
  insertAll(sessionsToInsert);

  const duration = Date.now() - startTime;
  console.error(
    `[indexer] Done in ${duration}ms: ${sessionsCount} sessions, ${messagesCount} messages, ${historyCount} history, ${toolUsageCount} tool usages, ${insightsCount} insights`
  );

  return {
    sessions: sessionsCount,
    messages: messagesCount,
    history_entries: historyCount,
    tool_usages: toolUsageCount,
    insights: insightsCount,
    duration_ms: duration,
  };
}

/**
 * Force a complete re-index by dropping all data first.
 */
export async function rebuildIndex(db: Database): Promise<IndexStats> {
  db.exec(`
    DELETE FROM messages;
    DELETE FROM messages_fts;
    DELETE FROM tool_usage;
    DELETE FROM history;
    DELETE FROM history_fts;
    DELETE FROM sessions;
    DELETE FROM index_meta;
    DELETE FROM session_insights;
    DELETE FROM insights_fts;
    DELETE FROM session_tags;
    DELETE FROM cross_references;
  `);
  return buildIndex(db);
}
