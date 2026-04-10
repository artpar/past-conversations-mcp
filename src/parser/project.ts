import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { PROJECTS_DIR } from "../utils/paths.js";

export interface DiscoveredSession {
  sessionId: string;
  projectSlug: string;
  jsonlPath: string | null;     // null if old-format-only
  dirPath: string | null;       // null if jsonl-only
  hasSubagents: boolean;
}

export interface DiscoveredProject {
  slug: string;
  path: string;
  sessions: DiscoveredSession[];
  memoryFiles: string[];
}

/**
 * Discover all projects and sessions in the ~/.claude/projects/ directory.
 */
export function discoverProjects(): DiscoveredProject[] {
  if (!existsSync(PROJECTS_DIR)) return [];

  const projects: DiscoveredProject[] = [];

  for (const entry of readdirSync(PROJECTS_DIR)) {
    const projectDir = join(PROJECTS_DIR, entry);
    const stat = statSync(projectDir);
    if (!stat.isDirectory()) continue;

    const project: DiscoveredProject = {
      slug: entry,
      path: projectDir,
      sessions: [],
      memoryFiles: [],
    };

    // Discover memory files
    const memoryDir = join(projectDir, "memory");
    if (existsSync(memoryDir)) {
      try {
        project.memoryFiles = readdirSync(memoryDir).filter(
          (f) => f.endsWith(".md")
        );
      } catch {
        // ignore
      }
    }

    // Discover sessions
    const sessionMap = new Map<string, { jsonl: boolean; dir: boolean }>();

    for (const item of readdirSync(projectDir)) {
      const itemPath = join(projectDir, item);

      if (item.endsWith(".jsonl")) {
        const sessionId = item.replace(".jsonl", "");
        const existing = sessionMap.get(sessionId) ?? { jsonl: false, dir: false };
        existing.jsonl = true;
        sessionMap.set(sessionId, existing);
      } else if (item !== "memory") {
        const itemStat = statSync(itemPath);
        if (itemStat.isDirectory()) {
          const existing = sessionMap.get(item) ?? { jsonl: false, dir: false };
          existing.dir = true;
          sessionMap.set(item, existing);
        }
      }
    }

    for (const [sessionId, info] of sessionMap) {
      const dirPath = info.dir ? join(projectDir, sessionId) : null;
      let hasSubagents = false;
      if (dirPath) {
        const subagentDir = join(dirPath, "subagents");
        hasSubagents = existsSync(subagentDir);
      }

      project.sessions.push({
        sessionId,
        projectSlug: entry,
        jsonlPath: info.jsonl ? join(projectDir, sessionId + ".jsonl") : null,
        dirPath,
        hasSubagents,
      });
    }

    projects.push(project);
  }

  return projects;
}

/**
 * List subagent JSONL files for a session directory.
 */
export function listSubagentFiles(sessionDir: string): string[] {
  const subagentDir = join(sessionDir, "subagents");
  if (!existsSync(subagentDir)) return [];

  return readdirSync(subagentDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(subagentDir, f));
}
