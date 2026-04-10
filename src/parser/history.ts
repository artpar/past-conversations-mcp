import { createReadStream } from "fs";
import { createInterface } from "readline";
import type { HistoryEntry } from "../types.js";

/**
 * Parse history.jsonl, yielding all entries.
 */
export async function* streamHistory(filePath: string): AsyncGenerator<HistoryEntry> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (entry.display && entry.sessionId) {
        yield entry;
      }
    } catch {
      // Skip malformed lines
    }
  }
}

/**
 * Parse history.jsonl starting from a byte offset (for incremental reads).
 */
export async function* streamHistoryFromOffset(
  filePath: string,
  byteOffset: number
): AsyncGenerator<HistoryEntry> {
  const stream = createReadStream(filePath, {
    encoding: "utf-8",
    start: byteOffset,
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let isFirst = true;
  for await (const line of rl) {
    // If we started mid-line, skip the first partial line
    if (isFirst && byteOffset > 0) {
      isFirst = false;
      continue;
    }
    isFirst = false;

    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (entry.display && entry.sessionId) {
        yield entry;
      }
    } catch {
      // Skip malformed or partial lines
    }
  }
}
