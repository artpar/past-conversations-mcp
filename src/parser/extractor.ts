import type { ParsedConversation } from "./jsonl.js";

export interface InsightRecord {
  type: string;
  summary: string;
  detail: string;
  confidence: number;
  sourceIndex: number;
}

export interface CrossRefRecord {
  targetProject: string;
  type: string;
  context: string;
  messageIndex: number;
}

export interface ExtractionResult {
  insights: InsightRecord[];
  tags: string[];
  crossRefs: CrossRefRecord[];
}

// Decision patterns: "chose X because Y", "switched to X", etc.
const DECISION_PATTERNS = [
  /\b(chose|choosing|picked|switched to|migrated? to|replaced? .{1,30} with|going with|decided to|we(?:'ll| will) use)\b/i,
  /\b(the reason (?:is|was)|because of|due to|in order to|to avoid|the (?:right|best|correct) approach)\b/i,
  /\b(trade-?off|alternative|instead of|rather than|over .{1,20} because)\b/i,
];

// Error-fix patterns
const FIX_PATTERNS = [
  /\b(fixed by|the fix(?::|is| was)|resolved by|solution:|the problem was)\b/i,
  /\b(root cause:|the issue (?:is|was)|the bug (?:is|was)|caused by)\b/i,
  /\b(changing .{1,40} to .{1,40} (?:fixed|resolved|solved))\b/i,
];

// Cross-project reference patterns
const CROSS_REF_PATTERNS = [
  /\b(?:from|in|see|like|copied from|same (?:pattern|approach) as) the ([a-z][\w-]+) project\b/i,
  /\b(?:copied|ported|borrowed|taken) from ([a-z][\w-]+)\b/i,
];

// Tag keyword map
const TAG_KEYWORDS: Record<string, string[]> = {
  refactoring: ['refactor', 'restructure', 'reorganize', 'clean up', 'rewrite'],
  bugfix: ['bug', 'fix', 'broken', 'regression', 'patch'],
  testing: ['test', 'spec', 'jest', 'vitest', 'assertion', 'coverage'],
  devops: ['deploy', 'ci', 'cd', 'pipeline', 'docker', 'kubernetes', 'build'],
  database: ['schema', 'migration', 'sqlite', 'postgres', 'mysql', 'query', 'index'],
  api: ['api', 'endpoint', 'route', 'rest', 'graphql', 'handler'],
  frontend: ['component', 'css', 'layout', 'react', 'vue', 'svelte', 'ui'],
  performance: ['perf', 'optimize', 'cache', 'latency', 'benchmark', 'profil'],
  security: ['auth', 'permission', 'token', 'encrypt', 'credential', 'oauth'],
  mcp: ['mcp', 'tool_use', 'mcp server', 'stdio transport'],
};

// File extension to language tag
const EXT_TAGS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.go': 'golang',
  '.py': 'python',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.css': 'css', '.scss': 'css',
  '.html': 'html',
  '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell',
};

function extractSentences(text: string, around: RegExp, maxLen: number = 300): { summary: string; detail: string } {
  const match = around.exec(text);
  if (!match || match.index === undefined) return { summary: '', detail: '' };

  // Find sentence boundaries around the match
  const before = text.slice(Math.max(0, match.index - 200), match.index);
  const after = text.slice(match.index, Math.min(text.length, match.index + 300));
  const combined = before + after;

  // Get the sentence containing the match
  const sentences = combined.split(/(?<=[.!?\n])\s+/).filter(s => s.trim());
  const matchStr = match[0].toLowerCase();
  const matchingSentence = sentences.find(s => s.toLowerCase().includes(matchStr)) ?? combined.slice(0, maxLen);

  const summary = matchingSentence.trim().slice(0, maxLen);
  const detail = combined.trim().slice(0, maxLen * 2);
  return { summary, detail };
}

export function extractKnowledge(
  parsed: ParsedConversation,
  sourceProject: string,
  knownProjects: string[],
): ExtractionResult {
  const insights: InsightRecord[] = [];
  const tags = new Set<string>();
  const crossRefs: CrossRefRecord[] = [];

  const seenInsights = new Set<string>();

  for (const msg of parsed.messages) {
    if (msg.role !== 'assistant') continue;
    const content = msg.content;

    // Decision extraction
    for (const pattern of DECISION_PATTERNS) {
      if (pattern.test(content)) {
        const { summary, detail } = extractSentences(content, pattern);
        if (summary && !seenInsights.has(summary.slice(0, 50))) {
          seenInsights.add(summary.slice(0, 50));
          // Higher confidence if multiple decision words in same message
          const matchCount = DECISION_PATTERNS.filter(p => p.test(content)).length;
          insights.push({
            type: 'decision',
            summary,
            detail,
            confidence: Math.min(1.0, 0.4 + matchCount * 0.15),
            sourceIndex: msg.messageIndex,
          });
        }
        break; // one decision per message
      }
    }

    // Error-fix extraction
    for (const pattern of FIX_PATTERNS) {
      if (pattern.test(content)) {
        const { summary, detail } = extractSentences(content, pattern);
        if (summary && !seenInsights.has(summary.slice(0, 50))) {
          seenInsights.add(summary.slice(0, 50));
          const matchCount = FIX_PATTERNS.filter(p => p.test(content)).length;
          insights.push({
            type: 'error_fix',
            summary,
            detail,
            confidence: Math.min(1.0, 0.5 + matchCount * 0.15),
            sourceIndex: msg.messageIndex,
          });
        }
        break;
      }
    }

    // Cross-project references: filesystem paths
    for (const projPath of knownProjects) {
      if (projPath === sourceProject) continue;
      if (content.includes(projPath)) {
        const projName = projPath.split('/').pop() ?? projPath;
        // Get surrounding context
        const idx = content.indexOf(projPath);
        const context = content.slice(Math.max(0, idx - 80), Math.min(content.length, idx + projPath.length + 80)).trim();
        const key = `${projPath}:${msg.messageIndex}`;
        if (!seenInsights.has(key)) {
          seenInsights.add(key);
          crossRefs.push({
            targetProject: projPath,
            type: 'path_mention',
            context,
            messageIndex: msg.messageIndex,
          });
        }
      }
    }

    // Cross-project references: natural language
    for (const pattern of CROSS_REF_PATTERNS) {
      const match = pattern.exec(content);
      if (match?.[1]) {
        const refName = match[1];
        const matchedProject = knownProjects.find(p =>
          p.endsWith('/' + refName) || p.endsWith('/' + refName.replace(/-/g, '/'))
        );
        if (matchedProject && matchedProject !== sourceProject) {
          const key = `${matchedProject}:${msg.messageIndex}`;
          if (!seenInsights.has(key)) {
            seenInsights.add(key);
            crossRefs.push({
              targetProject: matchedProject,
              type: 'copy_from',
              context: content.slice(Math.max(0, (match.index ?? 0) - 50), (match.index ?? 0) + match[0].length + 50).trim(),
              messageIndex: msg.messageIndex,
            });
          }
        }
      }
    }
  }

  // Tag extraction: from content keywords
  const allText = parsed.messages.slice(0, 5).map(m => m.content).join(' ').toLowerCase();
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some(kw => allText.includes(kw))) {
      tags.add(tag);
    }
  }

  // Tag extraction: from file extensions in tool usage
  for (const tu of parsed.toolUses) {
    if (tu.filePath) {
      const ext = tu.filePath.match(/\.[a-z]+$/)?.[0];
      if (ext && EXT_TAGS[ext]) {
        tags.add(EXT_TAGS[ext]);
      }
    }
  }

  return { insights, tags: [...tags], crossRefs };
}
