#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeDatabase } from "./db/schema.js";
import { buildIndex } from "./db/indexer.js";
import { INDEX_DB_PATH } from "./utils/paths.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerInsightTools } from "./tools/insights.js";

async function main() {
  console.error("[past-conversations] Starting MCP server...");
  console.error(`[past-conversations] Index path: ${INDEX_DB_PATH}`);

  // Initialize SQLite database
  const db = initializeDatabase(INDEX_DB_PATH);

  // Create MCP server
  const server = new McpServer({
    name: "past-conversations",
    version: "1.0.0",
  });

  // Register all tools
  registerSearchTools(server, db);
  registerSessionTools(server, db);
  registerProjectTools(server, db);
  registerAdminTools(server, db);
  registerInsightTools(server, db);

  // Check if index needs building
  const sessionCount = (
    db.prepare("SELECT COUNT(*) as count FROM sessions").get() as {
      count: number;
    }
  ).count;

  if (sessionCount === 0) {
    console.error("[past-conversations] Empty index, building...");
    await buildIndex(db);
  } else {
    console.error(
      `[past-conversations] Index has ${sessionCount} sessions, running incremental update...`
    );
    buildIndex(db).catch((err) =>
      console.error("[past-conversations] Background index error:", err)
    );
  }

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[past-conversations] MCP server running on stdio");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.error("[past-conversations] Shutting down...");
    db.close();
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    db.close();
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[past-conversations] Fatal error:", err);
  process.exit(1);
});
