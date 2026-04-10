import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

export const CLAUDE_DIR = join(homedir(), ".claude");
export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
export const INDEX_DB_PATH = join(CLAUDE_DIR, "past-conversations-index.db");

/**
 * Convert a project folder slug like "-Users-artpar-workspace-code-foo-bar"
 * to a real filesystem path like "/Users/artpar/workspace/code/foo-bar"
 *
 * The slug is the absolute path with / replaced by -.
 * Since directory names can contain dashes, we greedily match against
 * the actual filesystem to find the correct split points.
 */
export function slugToPath(slug: string): string {
  const withoutLeading = slug.startsWith("-") ? slug.slice(1) : slug;
  const parts = withoutLeading.split("-");

  // Greedy filesystem-based reconstruction:
  // Start from /, try to build the longest valid directory path at each step.
  // At each position, try joining the next N parts with dashes and check if
  // that directory exists. Take the longest match.
  let resolved = "";
  let i = 0;

  while (i < parts.length) {
    let bestLen = 1; // default: single part as next segment

    // Try joining multiple parts with dashes (longest first)
    const maxLookahead = Math.min(parts.length - i, 8);
    for (let len = maxLookahead; len >= 2; len--) {
      const candidate = parts.slice(i, i + len).join("-");
      const candidatePath = resolved + "/" + candidate;
      if (existsSync(candidatePath)) {
        bestLen = len;
        break;
      }
    }

    resolved += "/" + parts.slice(i, i + bestLen).join("-");
    i += bestLen;
  }

  return resolved;
}

/**
 * Convert a filesystem path to the project slug format
 */
export function pathToSlug(fsPath: string): string {
  return fsPath.replace(/\//g, "-");
}

/**
 * Extract a short project name from a slug for display
 * e.g. "-Users-artpar-workspace-code-foo" -> "foo"
 */
export function shortProjectName(slug: string): string {
  const parts = slug.replace(/^-/, "").split("-");
  // Take the last 1-2 segments as the project name
  // Skip common prefixes like Users, workspace, code
  const skipPrefixes = ["users", "home", "workspace", "code", "src"];
  let meaningful = parts.filter(
    (p) => !skipPrefixes.includes(p.toLowerCase())
  );
  if (meaningful.length === 0) meaningful = parts.slice(-1);
  return meaningful.join("-");
}
