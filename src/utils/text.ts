import type { RawContentBlock, RawMessage } from "../types.js";

/**
 * Extract user-visible text from a message's content field.
 * For user messages: returns the prompt text (skips tool_result blocks).
 * For assistant messages: returns text blocks (skips tool_use, thinking).
 */
export function extractText(message: RawMessage): string {
  const { content } = message;

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      texts.push(block.text);
    }
  }
  return texts.join("\n");
}

/**
 * Extract tool use information from assistant message content.
 * Returns array of {name, file_path, input_summary}.
 */
export function extractToolUses(
  message: RawMessage
): Array<{ name: string; file_path: string | null; input_summary: string }> {
  const { content } = message;
  if (typeof content === "string" || !Array.isArray(content)) {
    return [];
  }

  const results: Array<{
    name: string;
    file_path: string | null;
    input_summary: string;
  }> = [];

  for (const block of content) {
    if (block.type === "tool_use") {
      const filePath = extractFilePathFromToolInput(block.name, block.input);
      const inputStr = JSON.stringify(block.input);
      results.push({
        name: block.name,
        file_path: filePath,
        input_summary: inputStr.length > 200 ? inputStr.slice(0, 200) + "..." : inputStr,
      });
    }
  }

  return results;
}

/**
 * Try to extract a file path from a tool_use input, based on tool name.
 */
function extractFilePathFromToolInput(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return (input.file_path as string) ?? null;
    case "Glob":
      return (input.path as string) ?? null;
    case "Grep":
      return (input.path as string) ?? null;
    case "Bash":
      return null; // Can't reliably extract file paths from bash commands
    default:
      return null;
  }
}

/**
 * Generate a snippet of text around a match, with context.
 */
export function snippet(
  text: string,
  query: string,
  contextChars: number = 200
): string {
  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const idx = lower.indexOf(queryLower);

  if (idx === -1) {
    // FTS match might be stemmed, just return beginning
    return text.length > contextChars * 2
      ? text.slice(0, contextChars * 2) + "..."
      : text;
  }

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);

  let result = text.slice(start, end);
  if (start > 0) result = "..." + result;
  if (end < text.length) result = result + "...";
  return result;
}
