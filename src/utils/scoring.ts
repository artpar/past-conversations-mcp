export type MessageType = 'conclusion' | 'solution' | 'exploration' | 'error_report' | 'question' | 'content';

// ---- Content patterns (used as tiebreakers, NOT primary signals) ----

const CONCLUSION_PATTERNS = [
  /^(Root cause:|The issue was|The fix is|Summary:|In summary|Done\.|Here's what|What changed:)/im,
  /\b(the solution is|this works because|the problem was|resolved by switching|the real fix)\b/i,
  /\b(published|shipped|ready to|you can now|everything works|clean build)\b/i,
];

const SOLUTION_PATTERNS = [
  /\b(fixed by|the fix:|changed .{1,40} to|solution:)\b/i,
  /\b(the answer is|resolved by|the correct approach)\b/i,
];

const EXPLORATION_PATTERNS = [
  /^(Let me try|Let me check|Trying|Checking|Looking at|Let me see|Let me look)/i,
  /\b(still getting|that didn't work|doesn't work|not working|still fails)\b/i,
  /\b(hmm|hm,|interesting|wait —|wait,|actually,? re-reading)\b/i,
  /^(Running|Checking|Looking)\.\.\./,
  /\b(I'm overcomplicating|let me take a different approach|let me reconsider)\b/i,
  /\bStill v\d+/i,
];

const STRUCTURED_MARKDOWN = /^#{1,3}\s.+/m;
const BULLET_LIST = /^[-*]\s.+/m;

// ---- Turn-based scoring (primary path for full-transcript sessions) ----

export interface TurnContext {
  stopReason: string | null;
  hasThinking: boolean;
  toolCallCount: number;
  toolResultErrors: number;
  toolResultSuccesses: number;
  userFeedbackBefore: 'positive' | 'negative' | null;
  userFeedbackAfter: 'positive' | 'negative' | null;
  isErrorFixResolution: boolean;
  isPreCommit: boolean;
  isPostUserRejection: boolean;
  turnIndex: number;
  totalTurns: number;
  isLastTurn: boolean;
}

export function scoreTurn(
  assistantText: string,
  context: TurnContext,
): { importance: number; messageType: MessageType } {
  let importance = 0.3;

  // ---- Structural signals (primary) ----

  if (context.isPreCommit) importance += 0.30;
  if (context.isErrorFixResolution) importance += 0.25;
  if (context.userFeedbackAfter === 'positive') importance += 0.20;
  if (context.isLastTurn) importance += 0.15;
  if (context.userFeedbackAfter === 'negative') importance -= 0.20;
  if (context.stopReason === 'max_tokens') importance -= 0.15;
  if (context.toolResultErrors > 0 && context.toolResultSuccesses === 0) importance -= 0.10;

  // ---- Content signals (gated by structural context) ----

  const hasConclusion = CONCLUSION_PATTERNS.some(p => p.test(assistantText));
  const hasSolution = SOLUTION_PATTERNS.some(p => p.test(assistantText));
  const hasExploration = EXPLORATION_PATTERNS.some(p => p.test(assistantText));
  const positionRatio = context.totalTurns > 1 ? context.turnIndex / (context.totalTurns - 1) : 0;

  // Conclusion patterns only count with structural confirmation
  if (hasConclusion && (context.isPreCommit || positionRatio > 0.7 || context.userFeedbackAfter === 'positive')) {
    importance += 0.10;
  }
  // Solution patterns only count when actually resolving something
  if (hasSolution && context.isErrorFixResolution) {
    importance += 0.10;
  }
  // Exploration patterns penalize unless structurally important
  if (hasExploration && !context.isPreCommit && !context.isErrorFixResolution) {
    importance -= 0.15;
  }
  // Structured output (headers + bullets) is a summary signal
  if (STRUCTURED_MARKDOWN.test(assistantText) && BULLET_LIST.test(assistantText)) {
    importance += 0.05;
  }
  // Substantive content without exploration patterns
  if (assistantText.length > 500 && !hasExploration) {
    importance += 0.05;
  }

  // Position bonus (minor)
  importance += positionRatio * 0.05;

  importance = Math.min(1.0, Math.max(0.0, importance));

  // ---- Message type assignment (structural first) ----

  let messageType: MessageType = 'content';

  if (context.isPreCommit || (context.isLastTurn && context.userFeedbackAfter === 'positive') || (hasConclusion && positionRatio > 0.7)) {
    messageType = 'conclusion';
  } else if (context.isErrorFixResolution) {
    messageType = 'solution';
  } else if (hasExploration && !context.isPreCommit && !context.isErrorFixResolution) {
    messageType = 'exploration';
  } else if (context.toolResultErrors > 0 && context.toolResultSuccesses === 0) {
    messageType = 'error_report';
  }

  return { importance, messageType };
}

// ---- Legacy message-level scoring (for subagent/history paths without turn data) ----

export function scoreMessage(
  content: string,
  role: string,
  messageIndex: number,
  totalMessages: number,
  isLastAssistantMessage: boolean,
): { importance: number; messageType: MessageType } {
  if (role === 'user') {
    return { importance: messageIndex === 0 ? 0.6 : 0.4, messageType: 'question' };
  }

  let importance = 0.3;
  let messageType: MessageType = 'content';

  if (CONCLUSION_PATTERNS.some(p => p.test(content))) {
    importance = 0.7;
    messageType = 'conclusion';
  } else if (SOLUTION_PATTERNS.some(p => p.test(content))) {
    importance = 0.6;
    messageType = 'solution';
  } else if (EXPLORATION_PATTERNS.some(p => p.test(content))) {
    importance = 0.15;
    messageType = 'exploration';
  }

  const positionRatio = totalMessages > 1 ? messageIndex / (totalMessages - 1) : 0;
  importance += positionRatio * 0.05;
  if (isLastAssistantMessage) importance += 0.15;
  if (content.length < 50) importance -= 0.1;

  return { importance: Math.min(1.0, Math.max(0.0, importance)), messageType };
}

// ---- Session-level scoring (unchanged) ----

export type SessionOutcome = 'success' | 'partial' | 'abandoned' | 'error';

const ERROR_PATTERNS = [
  /\b(Error:|TypeError:|ENOENT|Cannot find module|SyntaxError:|ReferenceError:)\b/,
  /^\s+at\s+/m,
  /\b(SQL logic error|SQLITE_ERROR|permission denied)\b/i,
];

export function computeSessionOutcome(
  messages: Array<{ role: string; content: string }>,
  errorCount: number,
  commitCount: number,
): SessionOutcome {
  if (messages.length < 3) return 'abandoned';

  const lastUserMessages = messages.filter(m => m.role === 'user').slice(-3);
  const successWords = /\b(thanks|perfect|looks good|ship it|great|awesome|done|works|lgtm)\b/i;
  if (lastUserMessages.some(m => successWords.test(m.content))) return 'success';

  if (commitCount > 0 && errorCount === 0) return 'success';
  if (commitCount > 0) return 'partial';

  const lastAssistantMessages = messages.filter(m => m.role === 'assistant');
  const tail = lastAssistantMessages.slice(-Math.max(1, Math.floor(lastAssistantMessages.length * 0.2)));
  const tailHasErrors = tail.some(m => ERROR_PATTERNS.some(p => p.test(m.content)));
  if (errorCount > 0 && tailHasErrors) return 'error';

  return 'partial';
}

export function computeSessionImportance(opts: {
  commitCount: number;
  hasCustomTitle: boolean;
  outcome: SessionOutcome;
  messageCount: number;
  uniqueFileCount: number;
  uniqueDirCount: number;
  hasCrossRefs: boolean;
}): number {
  let score = 0;
  if (opts.commitCount > 0) score += 0.2;
  if (opts.hasCustomTitle) score += 0.1;
  if (opts.outcome === 'success') score += 0.1;
  score += 0.1 * Math.min(1, opts.messageCount / 50);
  if (opts.uniqueDirCount >= 3) score += 0.1;
  score += 0.2 * Math.min(1, opts.uniqueFileCount / 20);
  if (opts.hasCrossRefs) score += 0.1;
  return Math.min(1.0, Math.max(0.0, score));
}
