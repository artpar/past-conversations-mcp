import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/Database.js";
import { searchInsights, searchByContext, getProjectKnowledge } from "../db/queries.js";

export function registerInsightTools(server: McpServer, db: Database) {
  server.registerTool(
    "search_insights",
    {
      title: "Search Insights",
      description:
        "Search extracted knowledge: decisions, error fixes, patterns. " +
        "Returns distilled insights rather than raw conversation text. " +
        "Use this to find WHY decisions were made, not just WHAT was said.",
      inputSchema: z.object({
        query: z.string().describe("Search terms (FTS syntax: AND, OR, \"exact phrase\", prefix*)"),
        type: z.enum(["decision", "error_fix", "cross_ref", "outcome_summary", "any"]).default("any")
          .describe("Filter by insight type"),
        project: z.string().optional().describe("Filter by project path (partial match)"),
        min_confidence: z.coerce.number().min(0).max(1).default(0)
          .describe("Minimum confidence threshold (0-1). Use 0.5+ for high-quality insights."),
        limit: z.coerce.number().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const typeFilter = params.type === "any" ? undefined : params.type;
        const results = searchInsights(db, {
          query: params.query,
          type: typeFilter,
          project: params.project,
          min_confidence: params.min_confidence,
          limit: params.limit,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Search error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "search_by_context",
    {
      title: "Search by Context",
      description:
        "Find sessions by structured criteria: file paths modified, tools used, git branch, " +
        "outcome, or tags. Unlike text search, this searches session metadata. " +
        "Use for 'when did I last modify X?' or 'sessions that touched package.json'.",
      inputSchema: z.object({
        file_path: z.string().optional().describe("File path or pattern (partial match). E.g., 'package.json', 'src/db/'"),
        tool_name: z.string().optional().describe("Tool name. E.g., 'Write', 'Bash', 'Edit'"),
        project: z.string().optional().describe("Project path (partial match)"),
        date_from: z.string().optional().describe("Filter from date (ISO format)"),
        date_to: z.string().optional().describe("Filter to date (ISO format)"),
        outcome: z.enum(["success", "partial", "error", "abandoned"]).optional()
          .describe("Filter by session outcome"),
        tags: z.array(z.string()).optional()
          .describe("Filter by tags (AND logic). E.g., ['typescript', 'refactoring']"),
        limit: z.coerce.number().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const results = searchByContext(db, params);
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Search error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_project_knowledge",
    {
      title: "Get Project Knowledge",
      description:
        "Aggregated knowledge for a project: memory files, decisions, cross-project references, " +
        "recent sessions with outcomes, and tag distribution. " +
        "The main KT entry point — call this first when starting work on a project.",
      inputSchema: z.object({
        project: z.string().describe("Project path or name (partial match, e.g. 'daptin')"),
        include: z.array(z.enum(["memory", "decisions", "cross_refs", "recent_sessions", "tags"])).optional()
          .describe("Which sections to include. Default: all."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const results = getProjectKnowledge(db, params);
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );
}
