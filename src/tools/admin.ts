import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/Database.js";
import { z } from "zod";
import { rebuildIndex } from "../db/indexer.js";

export function registerAdminTools(server: McpServer, db: Database) {
  server.registerTool(
    "rebuild_index",
    {
      title: "Rebuild Index",
      description:
        "Force a complete re-index of all conversation data. " +
        "Use when the index seems stale or after manually modifying conversation files. " +
        "This drops all indexed data and rebuilds from scratch.",
      inputSchema: z.object({}),
      annotations: {
        destructiveHint: true,
      },
    },
    async () => {
      try {
        const stats = await rebuildIndex(db);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "success",
                  ...stats,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Rebuild failed: ${error}` },
          ],
          isError: true,
        };
      }
    }
  );
}
