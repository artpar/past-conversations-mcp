import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/Database.js";
import { searchConversations, searchHistory } from "../db/queries.js";

export function registerSearchTools(server: McpServer, db: Database) {
  server.registerTool(
    "search_conversations",
    {
      title: "Search Conversations",
      description:
        "Full-text search across all past Claude Code conversations. " +
        "Searches user prompts and assistant responses. " +
        "Supports FTS5 syntax: AND, OR, quoted phrases, prefix*. " +
        "Results are ranked by importance — conclusions and solutions rank higher than debugging noise.",
      inputSchema: z.object({
        query: z.string().describe("Search terms (FTS5 syntax: AND, OR, \"exact phrase\", prefix*)"),
        project: z.string().optional().describe("Filter by project path (partial match, e.g. 'daptin')"),
        date_from: z.string().optional().describe("Filter from date (ISO format, e.g. '2026-03-01')"),
        date_to: z.string().optional().describe("Filter to date (ISO format)"),
        role: z.enum(["user", "assistant", "any"]).default("any").describe("Filter by message role"),
        limit: z.coerce.number().min(1).max(100).default(20).describe("Max results to return"),
        min_importance: z.coerce.number().min(0).max(1).default(0)
          .describe("Filter to messages with importance >= this value (0-1). Use 0.5+ to focus on conclusions."),
        message_type: z.enum(["any", "conclusion", "solution", "exploration", "error_report", "question", "content"]).default("any")
          .describe("Filter by message type"),
        context_messages: z.coerce.number().min(0).max(5).default(0)
          .describe("Number of messages before and after each match to include for context"),
        group_by_session: z.boolean().default(false)
          .describe("When true, dedup to one best match per session"),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (params) => {
      try {
        const results = searchConversations(db, {
          ...params,
          message_type: params.message_type === "any" ? undefined : params.message_type,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "search_history",
    {
      title: "Search Prompt History",
      description:
        "Lightweight search over all user prompts (from history.jsonl). " +
        "Covers ALL sessions including older ones without full transcripts. " +
        "Good for 'did I ever ask about X?' type queries.",
      inputSchema: z.object({
        query: z.string().describe("Search terms (FTS5 syntax supported)"),
        project: z.string().optional().describe("Filter by project path (partial match)"),
        limit: z.coerce.number().min(1).max(100).default(30).describe("Max results"),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (params) => {
      try {
        const results = searchHistory(db, params);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error}` }],
          isError: true,
        };
      }
    }
  );
}
