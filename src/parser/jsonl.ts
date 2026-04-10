import { readFileSync } from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import type { RawRecord, RawContentBlock } from "../types.js";

/**
 * Stream-parse a JSONL file, yielding parsed records.
 * Handles malformed lines gracefully by skipping them.
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

/**
 * Extract only the records we care about for indexing from a conversation JSONL.
 */
export function parseConversationFile(filePath: string): ParsedConversation {
  const result: ParsedConversation = {
    sessionId: null,
    projectSlug: null,
    slug: null,
    customTitle: null,
    gitBranch: null,
    startedAt: null,
    lastActivity: null,
    messages: [],
    toolUses: [],
    errorCount: 0,
    commitCount: 0,
    totalTokens: 0,
    durationSeconds: 0,
  };

  let messageIndex = 0;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const record of parseJsonlSync(filePath)) {
    // Extract session metadata from first relevant record
    if (record.sessionId && !result.sessionId) {
      result.sessionId = record.sessionId;
    }
    if (record.slug && !result.slug) {
      result.slug = record.slug;
    }
    if (record.gitBranch && !result.gitBranch) {
      result.gitBranch = record.gitBranch;
    }

    // Track timestamps
    if (record.timestamp) {
      const ts = new Date(record.timestamp).getTime();
      if (!isNaN(ts)) {
        if (firstTimestamp === null || ts < firstTimestamp) firstTimestamp = ts;
        if (lastTimestamp === null || ts > lastTimestamp) lastTimestamp = ts;
      }
      if (!result.startedAt || record.timestamp < result.startedAt) {
        result.startedAt = record.timestamp;
      }
      if (!result.lastActivity || record.timestamp > result.lastActivity) {
        result.lastActivity = record.timestamp;
      }
    }

    switch (record.type) {
      case "custom-title":
        if (record.customTitle) result.customTitle = record.customTitle;
        break;

      case "user": {
        if (!record.message) break;
        const content = record.message.content;
        // Only index string content (actual user prompts), not tool_result arrays
        if (typeof content === "string" && content.trim()) {
          result.messages.push({
            role: "user",
            content: content,
            timestamp: record.timestamp ?? null,
            messageIndex: messageIndex++,
          });
        }
        // Check for tool_result errors in array content
        if (Array.isArray(content)) {
          for (const block of content as RawContentBlock[]) {
            if (block.type === "tool_result" && "is_error" in block && block.is_error) {
              result.errorCount++;
            }
          }
        }
        break;
      }

      case "assistant": {
        if (!record.message) break;
        const content = record.message.content;
        if (!Array.isArray(content)) break;

        // Track token usage
        if (record.message.usage && typeof record.message.usage === 'object') {
          const usage = record.message.usage as Record<string, unknown>;
          if (typeof usage.output_tokens === 'number') {
            result.totalTokens += usage.output_tokens;
          }
        }

        // Extract text blocks
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            texts.push(block.text);
          }
          if (block.type === "tool_use") {
            const fp = extractFilePath(block.name, block.input);
            result.toolUses.push({
              toolName: block.name,
              filePath: fp,
              timestamp: record.timestamp ?? null,
            });
            // Detect git commits via Bash tool
            if (block.name === "Bash" && typeof block.input?.command === "string") {
              if (/git\s+commit\b/.test(block.input.command as string)) {
                result.commitCount++;
              }
            }
          }
        }

        if (texts.length > 0) {
          result.messages.push({
            role: "assistant",
            content: texts.join("\n"),
            timestamp: record.timestamp ?? null,
            messageIndex: messageIndex++,
          });
        }
        break;
      }

      // Skip: progress, file-history-snapshot, system, queue-operation, last-prompt, agent-name
    }
  }

  // Compute duration
  if (firstTimestamp !== null && lastTimestamp !== null) {
    result.durationSeconds = Math.round((lastTimestamp - firstTimestamp) / 1000);
  }

  return result;
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
}
