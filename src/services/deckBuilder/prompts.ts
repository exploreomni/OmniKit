import type { InsightDigest } from './querySummary';

export const DECK_INSIGHT_PROMPT_VERSION = 'deck-builder-insight-v1';
export const DECK_INSIGHT_MAX_CHARS = 280;
const AI_REFUSAL_RE = /\b(i\s*(?:am|'m|’m)\s+sorry|i\s+cannot|i\s+can't|i\s+can’t|unable to|not able to|cannot provide|can't provide|can’t provide|decline|refuse)\b/i;

export function buildDeckInsightPrompt({
  dashboardName,
  tileName,
  digest,
}: {
  dashboardName: string;
  tileName: string;
  digest: InsightDigest;
}): string {
  return [
    `Prompt version: ${DECK_INSIGHT_PROMPT_VERSION}`,
    'You are a senior data analyst writing one executive takeaway for a PowerPoint slide.',
    'Use the provided tile digest as the source of truth. Do not invent data, fields, filters, or trends.',
    'Only run a query if the provided digest is insufficient, and say that the provided data was insufficient.',
    'Write 2-3 concise sentences, plain language, no markdown, no bullets, no hedging boilerplate.',
    'Name specific values, ranking changes, extrema, totals, averages, or visible patterns when they are present.',
    `Keep the final answer under about ${DECK_INSIGHT_MAX_CHARS} characters so it fits in the slide insight box.`,
    digest.empty
      ? 'The digest has zero rows. Refuse briefly with: No data was returned for this tile, so there is no trend to summarize.'
      : '',
    '',
    `Dashboard: ${dashboardName || 'Untitled dashboard'}`,
    `Slide tile: ${tileName || 'Untitled tile'}`,
    `Digest visual kind: ${digest.visualKind}`,
    '',
    '<tile_digest>',
    digest.text,
    '</tile_digest>',
  ].filter((line) => line !== '').join('\n');
}

export function cleanDeckInsightText(raw: string): { text: string; truncated: boolean } {
  const normalized = raw
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= DECK_INSIGHT_MAX_CHARS) return { text: normalized, truncated: false };
  const clipped = normalized.slice(0, DECK_INSIGHT_MAX_CHARS - 1);
  const sentenceEnd = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf('!'), clipped.lastIndexOf('?'));
  if (sentenceEnd >= 120) return { text: clipped.slice(0, sentenceEnd + 1).trim(), truncated: true };
  return { text: `${clipped.trim()}…`, truncated: true };
}

export function isDeckInsightRefusal(text: string): boolean {
  return AI_REFUSAL_RE.test(text.trim());
}
