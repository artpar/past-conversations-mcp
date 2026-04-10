import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/Database.js";
import { listProjects, getProjectMemory } from "../db/queries.js";

export function registerProjectTools(server: McpServer, db: Database) {
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "Overview of all projects with session counts, date ranges, memory files, " +
        "top tags, decision count, cross-references, and average importance.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        const results = listProjects(db);
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
    "get_project_memory",
    {
      title: "Get Project Memory",
      description:
        "Read the memory files for a project. Memory files contain curated knowledge " +
        "from past sessions: user preferences, project decisions, feedback, references.",
      inputSchema: z.object({
        project: z
          .string()
          .describe("Project path or slug (partial match, e.g. 'daptin')"),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (params) => {
      try {
        const results = getProjectMemory(db, params.project);
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No memory files found for project matching '${params.project}'`,
              },
            ],
          };
        }
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
}
