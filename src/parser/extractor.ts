import type { ParsedConversation } from "./jsonl.js";
import { extractSentenceAround } from "../utils/nlp.js";

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

// ---- Principle patterns: require BOTH a directive AND scope/rationale ----

const PRINCIPLE_PATTERNS = [
  // Prescriptive rules with scope (tight gap to avoid matching unrelated clauses)
  /\b(don't|do not|never|avoid)\b.{1,50}\b(when|if|unless|instead)\b/i,
  /\b(always|must|should not)\b.{1,50}\b(when|if|unless|before|after|instead)\b/i,
  // Explicit decision with rationale (tight co-occurrence)
  /\b(?:chose|switched to|going with|we'll use)\b.{1,60}\b(?:because|since|to avoid|instead of)\b/i,
  // Trade-off analysis with resolution
  /\b(?:trade-?off|pros and cons).{1,40}(?:chose|going with|decided|better)\b/i,
  // Root cause with explanation
  /\b(?:root cause|the (?:real )?(?:issue|problem|bug) was)\b.{1,80}\b(?:because|due to|caused by)\b/i,
];

// Error-fix summary patterns (used to extract the summary sentence from structurally-confirmed fixes)
const FIX_SUMMARY_PATTERNS = [
  /\b(fixed by|the fix(?::|is| was)|resolved by|solution:|the problem was)\b/i,
  /\b(root cause:|the issue (?:is|was)|caused by)\b/i,
];

// Cross-project reference patterns
const CROSS_REF_PATTERNS = [
  /\b(?:from|in|see|like|copied from|same (?:pattern|approach) as) the ([a-z][\w-]+) project\b/i,
  /\b(?:copied|ported|borrowed|taken) from ([a-z][\w-]+)\b/i,
];

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

// ---- NLP-based sentence extraction around a pattern match ----

function extractSentences(text: string, pattern: RegExp, maxLen: number = 300): { summary: string; detail: string } {
  const result = extractSentenceAround(text, pattern, 1);
  if (!result) return { summary: '', detail: '' };
  return {
    summary: result.matchSentence.slice(0, maxLen),
    detail: result.context.slice(0, maxLen * 2),
  };
}

// ---- Structural tag computation ----

function computeStructuralTags(parsed: ParsedConversation): string[] {
  const tags = new Set<string>();

  // Language tags from file extensions (structural)
  for (const tu of parsed.toolUses) {
    if (tu.filePath) {
      const ext = tu.filePath.match(/\.[a-z]+$/)?.[0];
      if (ext && EXT_TAGS[ext]) {
        tags.add(EXT_TAGS[ext]);
      }
    }
  }

  // Activity tags from tool patterns
  let writeOps = 0;
  let readOps = 0;
  for (const tu of parsed.toolUses) {
    if (tu.toolName === 'Write' || tu.toolName === 'Edit') writeOps++;
    if (tu.toolName === 'Read' || tu.toolName === 'Grep' || tu.toolName === 'Glob') readOps++;
  }

  if (parsed.errorFixPairs.length >= 2) tags.add('debugging');
  if (writeOps >= 5 && parsed.errorCount <= 1) tags.add('refactoring');
  if (readOps > writeOps * 3 && writeOps <= 2) tags.add('investigation');

  // File-path based tags
  const filePaths = parsed.toolUses.map(t => t.filePath).filter(Boolean) as string[];
  if (filePaths.some(f => /\.(test|spec)\.[tj]sx?$/.test(f) || f.includes('__tests__') || /\/test\//.test(f))) tags.add('testing');
  if (filePaths.some(f => /\b(Dockerfile|docker-compose|\.github|ci\.yml|cd\.yml|Makefile)\b/.test(f))) tags.add('devops');
  if (filePaths.some(f => /\.(sql|prisma)$/.test(f) || /\b(migration|schema)\b/i.test(f))) tags.add('database');
  if (filePaths.some(f => /\b(route|endpoint|handler|controller|api)\b/i.test(f))) tags.add('api');
  if (filePaths.some(f => /\.(css|scss|svelte|vue)$/.test(f) || /\bcomponent/i.test(f))) tags.add('frontend');

  // Bash command based tags
  for (const turn of parsed.turns) {
    for (const tc of turn.assistantToolCalls) {
      if (tc.bashCommand) {
        if (/\b(npm test|jest|vitest|pytest|cargo test|go test)\b/.test(tc.bashCommand)) tags.add('testing');
        if (/\b(docker|kubectl|terraform|ansible)\b/.test(tc.bashCommand)) tags.add('devops');
        if (/\b(git commit|git push|git merge)\b/.test(tc.bashCommand)) tags.add('git-workflow');
      }
    }
  }

  // Outcome-based tags
  if (parsed.commitCount > 0) tags.add('productive');
  if (parsed.errorFixPairs.length > 0 && parsed.commitCount > 0) tags.add('bugfix');

  return [...tags];
}

// ---- Main extraction function ----

export function extractKnowledge(
  parsed: ParsedConversation,
  sourceProject: string,
  knownProjects: string[],
): ExtractionResult {
  const insights: InsightRecord[] = [];
  const crossRefs: CrossRefRecord[] = [];
  const seenInsights = new Set<string>();

  // Pre-compute structural lookup sets
  const fixTurnSet = new Set(parsed.errorFixPairs.map(p => p.fixTurnIndex));
  const preCommitSet = new Set<number>();
  for (const ci of parsed.commitTurnIndices) {
    if (ci - 1 >= 0) preCommitSet.add(ci - 1);
    if (ci - 2 >= 0) preCommitSet.add(ci - 2);
  }
  const totalTurns = parsed.turns.length;

  // ---- Decision extraction: principle patterns + structural validation ----

  for (const turn of parsed.turns) {
    if (!turn.assistantText) continue;
    const content = turn.assistantText;
    const ti = turn.turnIndex;
    const positionRatio = totalTurns > 1 ? ti / (totalTurns - 1) : 0;

    // Pass 1: check for principle patterns
    for (const pattern of PRINCIPLE_PATTERNS) {
      if (!pattern.test(content)) continue;

      const { summary, detail } = extractSentences(content, pattern);
      if (!summary || seenInsights.has(summary.slice(0, 50))) continue;

      // Pass 2: structural validation — at least one condition must hold
      let conditionCount = 0;
      let confidence = 0.4;

      // Previous user was negative (this is the corrected approach)
      const isPostRejection = turn.userFeedback === 'negative' ||
        (ti > 0 && parsed.turns[ti - 1]?.userFeedback === 'negative');
      if (isPostRejection) { conditionCount++; confidence += 0.20; }

      // Next user confirmed
      const nextFeedback = ti + 1 < totalTurns ? parsed.turns[ti + 1]?.userFeedback : null;
      if (nextFeedback === 'positive') { conditionCount++; confidence += 0.15; }

      // Near a commit
      if (preCommitSet.has(ti)) { conditionCount++; confidence += 0.15; }

      // Resolves an error
      if (fixTurnSet.has(ti)) { conditionCount++; confidence += 0.10; }

      // Substantive and not early exploration
      if (content.length > 200 && positionRatio > 0.3) { conditionCount++; confidence += 0.05; }

      // Discard if no structural conditions met
      if (conditionCount === 0) continue;

      seenInsights.add(summary.slice(0, 50));
      insights.push({
        type: 'decision',
        summary,
        detail,
        confidence: Math.min(0.95, confidence),
        sourceIndex: ti,
      });
      break; // one decision per turn
    }

    // ---- Cross-project references (unchanged — already structural) ----

    for (const projPath of knownProjects) {
      if (projPath === sourceProject) continue;
      if (!content.includes(projPath)) continue;
      const idx = content.indexOf(projPath);
      const context = content.slice(Math.max(0, idx - 80), Math.min(content.length, idx + projPath.length + 80)).trim();
      const key = `${projPath}:${ti}`;
      if (!seenInsights.has(key)) {
        seenInsights.add(key);
        crossRefs.push({ targetProject: projPath, type: 'path_mention', context, messageIndex: ti });
      }
    }

    for (const pattern of CROSS_REF_PATTERNS) {
      const match = pattern.exec(content);
      if (!match?.[1]) continue;
      const matchedProject = knownProjects.find(p =>
        p.endsWith('/' + match[1]) || p.endsWith('/' + match[1].replace(/-/g, '/'))
      );
      if (matchedProject && matchedProject !== sourceProject) {
        const key = `${matchedProject}:${ti}`;
        if (!seenInsights.has(key)) {
          seenInsights.add(key);
          crossRefs.push({
            targetProject: matchedProject,
            type: 'copy_from',
            context: content.slice(Math.max(0, (match.index ?? 0) - 50), (match.index ?? 0) + match[0].length + 50).trim(),
            messageIndex: ti,
          });
        }
      }
    }
  }

  // ---- Error-fix extraction: from structural pairs, not regex ----

  for (const pair of parsed.errorFixPairs) {
    const fixTurn = parsed.turns[pair.fixTurnIndex];
    if (!fixTurn?.assistantText) continue;

    const content = fixTurn.assistantText;
    const key = `errorfix:${pair.fixTurnIndex}`;
    if (seenInsights.has(key)) continue;
    seenInsights.add(key);

    // Use FIX_SUMMARY_PATTERNS to extract the best summary sentence, or fall back to first 300 chars
    let summary = content.slice(0, 300);
    let detail = content.slice(0, 600);
    for (const pattern of FIX_SUMMARY_PATTERNS) {
      if (pattern.test(content)) {
        const extracted = extractSentences(content, pattern);
        if (extracted.summary) {
          summary = extracted.summary;
          detail = extracted.detail;
          break;
        }
      }
    }

    insights.push({
      type: 'error_fix',
      summary,
      detail,
      confidence: 0.7, // structurally confirmed — we KNOW it fixed an error
      sourceIndex: pair.fixTurnIndex,
    });
  }

  // ---- Tags: structural only ----
  const tags = computeStructuralTags(parsed);

  return { insights, tags, crossRefs };
}
