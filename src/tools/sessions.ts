import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/Database.js";
import { listSessions, getSession, getSessionContext } from "../db/queries.js";

export function registerSessionTools(server: McpServer, db: Database) {
  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "Browse past Claude Code sessions with summaries. " +
        "Shows session title, dates, message counts, outcome, and importance score. " +
        "Use to discover relevant sessions before diving deeper.",
      inputSchema: z.object({
        project: z.string().optional().describe("Filter by project path (partial match)"),
        query: z.string().optional().describe("Search in session titles/first prompts"),
        date_from: z.string().optional().describe("Filter from date (ISO)"),
        date_to: z.string().optional().describe("Filter to date (ISO)"),
        sort: z.enum(["recent", "oldest", "importance"]).default("recent").describe("Sort order"),
        limit: z.coerce.number().min(1).max(200).default(30).describe("Max results"),
        outcome: z.enum(["success", "partial", "error", "abandoned"]).optional()
          .describe("Filter by session outcome"),
        min_importance: z.coerce.number().min(0).max(1).optional()
          .describe("Filter to sessions with importance >= this value"),
        tags: z.array(z.string()).optional()
          .describe("Filter by tags (AND logic)"),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (params) => {
      try {
        const results = listSessions(db, params);
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
          content: [{ type: "text" as const, text: `Error: ${error}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_session",
    {
      title: "Get Session Transcript",
      description:
        "Retrieve the full conversation transcript of a specific session. " +
        "Use 'all' include mode to also see tool usage details. " +
        "Supports pagination with offset/limit.",
      inputSchema: z.object({
        session_id: z.string().describe("The session UUID"),
        include: z
          .enum(["messages", "all"])
          .default("messages")
          .describe("'messages' for text only, 'all' to include tool use details"),
        offset: z.coerce.number().min(0).default(0).describe("Skip N messages from start"),
        limit: z.coerce.number().min(1).max(500).default(100).describe("Max messages to return"),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (params) => {
      try {
        const result = getSession(db, params);
        if (!result.metadata) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Session ${params.session_id} not found`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_session_context",
    {
      title: "Get Session Context",
      description:
        "Rich context about a session: user prompts, assistant responses, " +
        "files touched, tools used, extracted insights, tags, cross-project references, " +
        "outcome, and importance score. The main KT (knowledge transfer) tool.",
      inputSchema: z.object({
        session_id: z.string().describe("The session UUID"),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (params) => {
      try {
        const result = getSessionContext(db, params.session_id);
        if (!result) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Session ${params.session_id} not found`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error}` }],
          isError: true,
        };
      }
    }
  );
}
