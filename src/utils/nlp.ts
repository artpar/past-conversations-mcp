/**
 * NLP utilities using compromise + wink-sentiment for deterministic text analysis.
 * All functions are pure and deterministic — same input always produces same output.
 */

import nlp from "compromise";

// wink-sentiment is CJS, imported via createRequire or dynamic import
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const sentiment: (text: string) => { score: number; normalizedScore: number } = require("wink-sentiment");

// ---- Sentence splitting ----

/**
 * Split text into sentences using compromise's NLP parser.
 * Handles abbreviations (Mr., Dr., e.g.), URLs, code references properly.
 */
export function splitSentences(text: string): string[] {
  if (!text || text.length < 5) return text ? [text] : [];
  const doc = nlp(text);
  const sentences = doc.sentences().json() as Array<{ text: string }>;
  return sentences.map(s => s.text).filter(s => s.trim().length > 0);
}

/**
 * Extract the sentence containing a regex match, plus N surrounding sentences for context.
 * Returns { matchSentence, context } where context includes ±surroundCount sentences.
 */
export function extractSentenceAround(
  text: string,
  pattern: RegExp,
  surroundCount: number = 1,
): { matchSentence: string; context: string } | null {
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return null;

  const sentences = splitSentences(text);
  if (sentences.length === 0) return null;

  // Find which sentence contains the match by character position
  let charPos = 0;
  let matchSentenceIdx = 0;
  for (let i = 0; i < sentences.length; i++) {
    const sentenceStart = text.indexOf(sentences[i], charPos);
    if (sentenceStart === -1) continue;
    const sentenceEnd = sentenceStart + sentences[i].length;
    if (match.index >= sentenceStart && match.index < sentenceEnd) {
      matchSentenceIdx = i;
      break;
    }
    charPos = sentenceEnd;
  }

  const startIdx = Math.max(0, matchSentenceIdx - surroundCount);
  const endIdx = Math.min(sentences.length - 1, matchSentenceIdx + surroundCount);
  const contextSentences = sentences.slice(startIdx, endIdx + 1);

  return {
    matchSentence: sentences[matchSentenceIdx],
    context: contextSentences.join(' '),
  };
}

// ---- Sentiment analysis ----

export interface SentimentResult {
  score: number;           // raw AFINN score
  normalizedScore: number; // normalized to word count
  label: 'positive' | 'negative' | 'neutral';
}

/**
 * Analyze sentiment of text using AFINN-165 lexicon (via wink-sentiment).
 * Deterministic — same text always produces same score.
 *
 * normalizedScore ranges:
 *   > 0.5  → clearly positive
 *   < -0.5 → clearly negative
 *   -0.5 to 0.5 → neutral
 */
export function analyzeSentiment(text: string): SentimentResult {
  if (!text || text.length < 2) return { score: 0, normalizedScore: 0, label: 'neutral' };

  const result = sentiment(text);
  let label: SentimentResult['label'] = 'neutral';
  if (result.normalizedScore > 0.5) label = 'positive';
  else if (result.normalizedScore < -0.5) label = 'negative';

  return {
    score: result.score,
    normalizedScore: result.normalizedScore,
    label,
  };
}

/**
 * Classify user feedback from a message.
 * Uses sentiment analysis for short messages, skips long prompts.
 * Optimized: only runs sentiment on messages likely to be feedback (short + simple).
 */
export function classifyUserFeedback(content: string): 'positive' | 'negative' | null {
  // Long messages are instructions/prompts, not feedback
  if (content.length > 200) return null;

  // Very short messages — use sentiment directly (fast path)
  const { normalizedScore } = analyzeSentiment(content);

  // Strong sentiment is clear feedback
  if (normalizedScore >= 1.0) return 'positive';
  if (normalizedScore <= -1.0) return 'negative';

  // For moderate scores, only classify if message is very short
  if (content.length <= 60) {
    if (normalizedScore > 0.3) return 'positive';
    if (normalizedScore < -0.3) return 'negative';
  }

  return null;
}

