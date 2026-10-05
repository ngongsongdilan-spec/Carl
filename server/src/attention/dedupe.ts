import type { AttentionCategory } from '../domain/types.js';

/**
 * Stable deduplication keys.
 *
 * Two emails about the same real-world event (a reminder three days after a
 * deadline notice, or the same request appearing in two threads) must collapse
 * into one attention item. The key is `category:normalized-entity:time-bucket`.
 *
 * The time bucket is deliberately coarse: two days is wide enough to merge a
 * notice and its reminder, and narrow enough that a *new* bill next month is a
 * separate item.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'was',
  'your', 'you', 'our', 'we', 'my', 'this', 'that', 'with', 'from', 'by', 'as', 'be',
  'it', 'its', 'has', 'have', 'not', 'no', 'will', 'can', 'please', 'about',
  'upcoming', 'required', 'attention', 'reminder', 'important', 'update',
]);

const BUCKET_MS = 2 * 24 * 60 * 60 * 1000;

/** Strips reply prefixes, filler, and punctuation to get a stable phrase. */
export function normalizeTitle(subject: string): string {
  return subject
    .replace(/^(?:(?:re|aw|sv|vs|fwd|fw|tr)\s*(?:\[\d+\])?\s*:\s*)+/i, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, 6)
    .join(' ')
    .toLowerCase();
}

/** Extracts comparable entity tokens: amounts, dates, identifiers, quoted nouns. */
export function entityTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const m of text.matchAll(/[$€£]\s?\d[\d,.]*/g)) tokens.push(m[0].replace(/\s+/g, ''));
  for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) tokens.push(m[0]);
  for (const m of text.matchAll(
    /\b(?:inv(?:oice)?|ref(?:erence)?|order|ticket|case|id|number|no)\s*[:#]?\s*([a-z0-9-]{3,})/gi,
  )) {
    tokens.push(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/"([^"]{3,40})"/g)) tokens.push(m[1].toLowerCase());
  return tokens.slice(0, 4);
}

export interface EventKeyInput {
  category: AttentionCategory | string;
  subject: string;
  bodyText?: string;
  date: Date;
  threadId: string | null;
}

export function eventKeyFor(input: EventKeyInput): string {
  const entities = entityTokens(`${input.subject} ${(input.bodyText ?? '').slice(0, 400)}`);
  const entityPart =
    entities.length > 0 ? entities.slice().sort().join('|') : normalizeTitle(input.subject);
  const bucket = Math.floor(input.date.getTime() / BUCKET_MS);
  return `${input.category}::${entityPart}::${bucket}::${input.threadId ?? 'none'}`;
}

function titleSimilarity(a: string, b: string): number {
  const wa = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const wb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

export interface ExistingForDedupe {
  eventKey: string;
  category: string;
  subject: string;
  createdAt: string;
  threadId: string | null;
}

export interface DedupeCheck {
  category: string;
  subject: string;
  bodyText?: string;
  date: Date;
  threadId: string | null;
  /** How far apart two notices about the same event may be. */
  windowHours?: number;
}

/**
 * Near-duplicate test used when merging a new analysis run into the existing
 * feed. Checks, in order: exact event key, same thread, then title similarity
 * inside a time window.
 */
export function isDuplicateOf(existing: ExistingForDedupe, candidate: DedupeCheck): boolean {
  const candidateKey = eventKeyFor({
    category: candidate.category,
    subject: candidate.subject,
    bodyText: candidate.bodyText,
    date: candidate.date,
    threadId: candidate.threadId,
  });
  if (existing.eventKey === candidateKey) return true;

  if (candidate.threadId && existing.threadId && candidate.threadId === existing.threadId) return true;

  if (existing.category !== candidate.category) return false;

  const windowHours = candidate.windowHours ?? 72;
  const ageHours = (candidate.date.getTime() - Date.parse(existing.createdAt)) / 3_600_000;
  if (Number.isFinite(ageHours) && ageHours < -(windowHours * 24) * 10) return false;

  return titleSimilarity(candidate.subject, existing.subject) >= 0.6;
}
