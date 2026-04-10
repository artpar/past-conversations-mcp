export type MessageType = 'conclusion' | 'solution' | 'exploration' | 'error_report' | 'question' | 'content';

const CONCLUSION_PATTERNS = [
  /^(Root cause:|The issue was|The fix is|Summary:|In summary|Done\.|Here's what|What changed:)/im,
  /\b(the solution is|this works because|the problem was|resolved by switching|the real fix)\b/i,
  /\b(successfully|all tests pass|deployed|merged|completed|working now|clean build)\b/i,
  /\b(published|shipped|ready to|you can now|everything works)\b/i,
];

const SOLUTION_PATTERNS = [
  /\b(fixed by|the fix:|changed .{1,40} to|replacing .{1,40} with|solution:)\b/i,
  /\b(the answer is|resolved by|you need to|the correct approach)\b/i,
  /\b(here's how|the way to fix|to solve this)\b/i,
];

const EXPLORATION_PATTERNS = [
  /^(Let me try|Let me check|Trying|Checking|Looking at|Let me see|Let me look)/i,
  /\b(still getting|that didn't work|doesn't work|not working|still fails)\b/i,
  /\b(hmm|hm,|interesting|wait —|wait,|actually,? re-reading)\b/i,
  /^(Running|Checking|Looking)\.\.\./,
  /\b(I'm overcomplicating|let me take a different approach|let me reconsider)\b/i,
  /\bStill v\d+/i,
];

const ERROR_PATTERNS = [
  /\b(Error:|TypeError:|ENOENT|Cannot find module|SyntaxError:|ReferenceError:)\b/,
  /^\s+at\s+/m,
  /\b(stack trace|segfault|panic|SIGABRT|SIGSEGV)\b/i,
  /\b(SQL logic error|SQLITE_ERROR|permission denied)\b/i,
];

export function scoreMessage(
  content: string,
  role: string,
  messageIndex: number,
  totalMessages: number,
  isLastAssistantMessage: boolean,
): { importance: number; messageType: MessageType } {
  if (role === 'user') {
    const importance = messageIndex === 0 ? 0.6 : 0.4;
    return { importance, messageType: 'question' };
  }

  let importance = 0.3;
  let messageType: MessageType = 'content';

  // Check patterns in priority order
  if (CONCLUSION_PATTERNS.some(p => p.test(content))) {
    importance = 0.85;
    messageType = 'conclusion';
  } else if (SOLUTION_PATTERNS.some(p => p.test(content))) {
    importance = 0.75;
    messageType = 'solution';
  } else if (EXPLORATION_PATTERNS.some(p => p.test(content))) {
    importance = 0.15;
    messageType = 'exploration';
  } else if (ERROR_PATTERNS.some(p => p.test(content))) {
    importance = 0.4;
    messageType = 'error_report';
  }

  // Position boost: later messages more likely to be conclusions
  const positionRatio = totalMessages > 1 ? messageIndex / (totalMessages - 1) : 0;
  importance += positionRatio * 0.1;

  // Last assistant message bonus
  if (isLastAssistantMessage) importance += 0.15;

  // Length signals
  if (content.length < 50) importance -= 0.1;
  if (content.length > 500 && messageType === 'content') importance += 0.05;

  // Contains code block (substantive)
  if (/```[\s\S]{20,}```/.test(content) && messageType === 'content') {
    importance += 0.05;
  }

  return {
    importance: Math.min(1.0, Math.max(0.0, importance)),
    messageType,
  };
}

export type SessionOutcome = 'success' | 'partial' | 'abandoned' | 'error';

export function computeSessionOutcome(
  messages: Array<{ role: string; content: string }>,
  errorCount: number,
  commitCount: number,
): SessionOutcome {
  if (messages.length < 3) return 'abandoned';

  // Check last user messages for success signals
  const lastUserMessages = messages.filter(m => m.role === 'user').slice(-3);
  const successWords = /\b(thanks|perfect|looks good|ship it|great|awesome|done|works|lgtm)\b/i;
  if (lastUserMessages.some(m => successWords.test(m.content))) return 'success';

  // Has commits and no trailing errors
  if (commitCount > 0 && errorCount === 0) return 'success';
  if (commitCount > 0) return 'partial';

  // Errors in last 20% of messages
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
