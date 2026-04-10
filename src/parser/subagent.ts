import { streamJsonl } from "./jsonl.js";

export interface SubagentSummary {
  messageCount: number;
  userPrompts: string[];
  assistantTexts: string[];
}

/**
 * Parse a subagent JSONL file and extract user/assistant text.
 * Returns a summary rather than full records to keep memory usage low.
 */
export async function parseSubagentFile(filePath: string): Promise<SubagentSummary> {
  const result: SubagentSummary = {
    messageCount: 0,
    userPrompts: [],
    assistantTexts: [],
  };

  for await (const record of streamJsonl(filePath)) {
    if (record.type === "user" && record.message) {
      const content = record.message.content;
      if (typeof content === "string" && content.trim()) {
        result.userPrompts.push(content);
        result.messageCount++;
      }
    } else if (record.type === "assistant" && record.message) {
      const content = record.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            result.assistantTexts.push(block.text);
            result.messageCount++;
          }
        }
      }
    }
  }

  return result;
}
