import { readFileSync } from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import type { RawRecord, RawContentBlock } from "../types.js";
import { classifyUserFeedback } from "../utils/nlp.js";

/**
 * Stream-parse a JSONL file, yielding parsed records.
 */
export async function* streamJsonl(filePath: string): AsyncGenerator<RawRecord> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RawRecord;
    } catch {
      // Skip malformed lines
    }
  }
}

function parseJsonlSync(filePath: string): RawRecord[] {
  const content = readFileSync(filePath, "utf-8");
  const records: RawRecord[] = [];
  let start = 0;
  while (start < content.length) {
    const end = content.indexOf("\n", start);
    const line = end === -1 ? content.slice(start) : content.slice(start, end);
    start = end === -1 ? content.length : end + 1;
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as RawRecord);
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

// ---- Turn-based parsing ----

export interface ParsedTurn {
  userContent: string | null;
  userFeedback: 'positive' | 'negative' | null;
  hasToolResults: boolean;
  toolResultErrors: number;
  toolResultSuccesses: number;
  assistantText: string | null;
  assistantToolCalls: Array<{
    name: string;
    filePath: string | null;
    bashCommand: string | null;
  }>;
  stopReason: string | null;
  hasThinking: boolean;
  turnIndex: number;
  timestamp: string | null;
}

/**
 * Extract records into a turn-based structure + backward-compat flat arrays.
 */
export function parseConversationFile(filePath: string): ParsedConversation {
  const records = parseJsonlSync(filePath);

  // ---- Metadata extraction (single pass) ----
  let sessionId: string | null = null;
  let slug: string | null = null;
  let customTitle: string | null = null;
  let gitBranch: string | null = null;
  let startedAt: string | null = null;
  let lastActivity: string | null = null;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const record of records) {
    if (record.sessionId && !sessionId) sessionId = record.sessionId;
    if (record.slug && !slug) slug = record.slug;
    if (record.gitBranch && !gitBranch) gitBranch = record.gitBranch;
    if (record.type === "custom-title" && record.customTitle) customTitle = record.customTitle;
    if (record.timestamp) {
      const ts = new Date(record.timestamp).getTime();
      if (!isNaN(ts)) {
        if (firstTimestamp === null || ts < firstTimestamp) firstTimestamp = ts;
        if (lastTimestamp === null || ts > lastTimestamp) lastTimestamp = ts;
      }
      if (!startedAt || record.timestamp < startedAt) startedAt = record.timestamp;
      if (!lastActivity || record.timestamp > lastActivity) lastActivity = record.timestamp;
    }
  }

  // ---- Build turns from records ----
  // A turn starts with a user text message and includes all records until the next user text message.
  // User tool_result records are WITHIN the turn (they're tool feedback, not new prompts).

  const turns: ParsedTurn[] = [];
  let currentTurn: {
    userContent: string | null;
    userFeedback: 'positive' | 'negative' | null;
    toolResultErrors: number;
    toolResultSuccesses: number;
    hasToolResults: boolean;
    texts: string[];
    toolCalls: ParsedTurn['assistantToolCalls'];
    stopReason: string | null;
    hasThinking: boolean;
    timestamp: string | null;
  } | null = null;

  // Also build backward-compat flat arrays
  const flatMessages: ParsedConversation['messages'] = [];
  const flatToolUses: ParsedConversation['toolUses'] = [];
  let messageIndex = 0;
  let errorCount = 0;
  let commitCount = 0;
  let totalTokens = 0;

  function finalizeTurn() {
    if (!currentTurn) return;
    const assistantText = currentTurn.texts.length > 0 ? currentTurn.texts.join("\n") : null;
    turns.push({
      userContent: currentTurn.userContent,
      userFeedback: currentTurn.userFeedback,
      hasToolResults: currentTurn.hasToolResults,
      toolResultErrors: currentTurn.toolResultErrors,
      toolResultSuccesses: currentTurn.toolResultSuccesses,
      assistantText,
      assistantToolCalls: currentTurn.toolCalls,
      stopReason: currentTurn.stopReason,
      hasThinking: currentTurn.hasThinking,
      turnIndex: turns.length,
      timestamp: currentTurn.timestamp,
    });
    currentTurn = null;
  }

  for (const record of records) {
    if (record.type === "user" && record.message) {
      const content = record.message.content;

      if (typeof content === "string" && content.trim()) {
        // User text message → starts a new turn
        finalizeTurn();
        const feedback = classifyUserFeedback(content);
        currentTurn = {
          userContent: content,
          userFeedback: feedback,
          toolResultErrors: 0,
          toolResultSuccesses: 0,
          hasToolResults: false,
          texts: [],
          toolCalls: [],
          stopReason: null,
          hasThinking: false,
          timestamp: record.timestamp ?? null,
        };
        // Flat array: add user message
        flatMessages.push({
          role: "user",
          content,
          timestamp: record.timestamp ?? null,
          messageIndex: messageIndex++,
        });
      } else if (Array.isArray(content)) {
        // User tool_result record → stays within current turn
        for (const block of content as RawContentBlock[]) {
          if (block.type === "tool_result") {
            if (currentTurn) {
              currentTurn.hasToolResults = true;
              if ("is_error" in block && block.is_error) {
                currentTurn.toolResultErrors++;
                errorCount++;
              } else {
                currentTurn.toolResultSuccesses++;
              }
            } else {
              // tool_result before first user text — still count errors
              if ("is_error" in block && block.is_error) errorCount++;
            }
          }
        }
      }
    } else if (record.type === "assistant" && record.message) {
      const content = record.message.content;
      if (!Array.isArray(content)) continue;

      // Track token usage
      if (record.message.usage && typeof record.message.usage === 'object') {
        const usage = record.message.usage as Record<string, unknown>;
        if (typeof usage.output_tokens === 'number') {
          totalTokens += usage.output_tokens;
        }
      }

      // If no current turn yet (assistant before first user message), create a stub
      if (!currentTurn) {
        currentTurn = {
          userContent: null,
          userFeedback: null,
          toolResultErrors: 0,
          toolResultSuccesses: 0,
          hasToolResults: false,
          texts: [],
          toolCalls: [],
          stopReason: null,
          hasThinking: false,
          timestamp: record.timestamp ?? null,
        };
      }

      // Track stop_reason (keep the last non-null value for this turn)
      if (record.message.stop_reason) {
        currentTurn.stopReason = record.message.stop_reason;
      }

      for (const block of content) {
        if (block.type === "thinking") {
          currentTurn.hasThinking = true;
        } else if (block.type === "text" && block.text?.trim()) {
          currentTurn.texts.push(block.text);
          // Flat array: add assistant text message
          flatMessages.push({
            role: "assistant",
            content: block.text,
            timestamp: record.timestamp ?? null,
            messageIndex: messageIndex++,
          });
        } else if (block.type === "tool_use") {
          const fp = extractFilePath(block.name, block.input);
          const bashCmd = (block.name === "Bash" && typeof block.input?.command === "string")
            ? (block.input.command as string).slice(0, 200)
            : null;

          currentTurn.toolCalls.push({
            name: block.name,
            filePath: fp,
            bashCommand: bashCmd,
          });

          // Flat array: add tool use
          flatToolUses.push({
            toolName: block.name,
            filePath: fp,
            timestamp: record.timestamp ?? null,
          });

          // Detect git commits
          if (bashCmd && /git\s+commit\b/.test(bashCmd)) {
            commitCount++;
          }
        }
      }
    }
    // Skip: progress, file-history-snapshot, system, queue-operation, last-prompt, agent-name
  }
  finalizeTurn();

  // ---- Build derived sequences ----

  // errorFixPairs: turn with errors → turn within 4 steps where tools succeed
  const errorFixPairs: Array<{ errorTurnIndex: number; fixTurnIndex: number }> = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].toolResultErrors > 0) {
      for (let j = i + 1; j < Math.min(i + 5, turns.length); j++) {
        if (turns[j].toolResultSuccesses > 0 && turns[j].assistantText) {
          errorFixPairs.push({ errorTurnIndex: i, fixTurnIndex: j });
          break;
        }
      }
    }
  }

  // commitTurnIndices: turns containing git commit calls
  const commitTurnIndices: number[] = [];
  for (const turn of turns) {
    if (turn.assistantToolCalls.some(tc => tc.bashCommand && /git\s+commit\b/.test(tc.bashCommand))) {
      commitTurnIndices.push(turn.turnIndex);
    }
  }

  const durationSeconds = (firstTimestamp !== null && lastTimestamp !== null)
    ? Math.round((lastTimestamp - firstTimestamp) / 1000)
    : 0;

  return {
    sessionId,
    projectSlug: null,
    slug,
    customTitle,
    gitBranch,
    startedAt,
    lastActivity,
    messages: flatMessages,
    toolUses: flatToolUses,
    errorCount,
    commitCount,
    totalTokens,
    durationSeconds,
    turns,
    errorFixPairs,
    commitTurnIndices,
  };
}

function extractFilePath(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return typeof input.file_path === "string" ? input.file_path : null;
    case "Glob":
    case "Grep":
      return typeof input.path === "string" ? input.path : null;
    default:
      return null;
  }
}

export interface ParsedConversation {
  sessionId: string | null;
  projectSlug: string | null;
  slug: string | null;
  customTitle: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  lastActivity: string | null;
  // Backward-compat flat arrays (used by indexer for DB inserts)
  messages: Array<{
    role: string;
    content: string;
    timestamp: string | null;
    messageIndex: number;
  }>;
  toolUses: Array<{
    toolName: string;
    filePath: string | null;
    timestamp: string | null;
  }>;
  errorCount: number;
  commitCount: number;
  totalTokens: number;
  durationSeconds: number;
  // Turn-based structure (used by scoring + extraction)
  turns: ParsedTurn[];
  errorFixPairs: Array<{ errorTurnIndex: number; fixTurnIndex: number }>;
  commitTurnIndices: number[];
}
