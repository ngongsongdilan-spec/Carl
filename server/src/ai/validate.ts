import type {
  AIVerdict,
  AttentionCategory,
  DeadlineDraft,
  NormalizedEmail,
  Priority,
  ThreadContext,
} from '../domain/types.js';
import { clampConfidence, isAttentionCategory, isPriority } from '../domain/types.js';
import { z } from 'zod';

/**
 * AI output is untrusted data.
 *
 * A model can return anything: prose instead of JSON, a truncated string, a
 * confidence of 47, a category that does not exist, or an attempt to smuggle
 * instructions into a field. Every response goes through this module, which:
 *
 *   1. tolerates prose/fenced-code wrappers around JSON
 *   2. validates shape with zod
 *   3. coerces unknown enums to safe defaults
 *   4. clamps every string length and every number range
 *   5. strips control characters
 *
 * A failure returns `null`, and the caller falls back to the deterministic
 * verdict. Nothing here throws.
 */

const DEADLINE_SCHEMA = z
  .object({
    iso: z.string().nullable().optional(),
    raw: z.string().nullable().optional(),
    kind: z.enum(['explicit', 'relative', 'expiry']).optional(),
    confidence: z.number().optional(),
  })
  .nullable()
  .optional();

export const AI_VERDICT_SCHEMA = z.object({
  is_attention_item: z.boolean(),
  category: z.string(),
  priority: z.string(),
  title: z.string(),
  summary: z.string(),
  why_it_matters: z.string(),
  recommended_action: z.string(),
  deadline: DEADLINE_SCHEMA,
  confidence: z.number(),
});

export type RawAIVerdict = z.infer<typeof AI_VERDICT_SCHEMA>;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clean(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function coerceDeadline(raw: RawAIVerdict['deadline']): DeadlineDraft {
  if (!raw || typeof raw !== 'object') {
    return { iso: null, raw: null, kind: 'explicit', confidence: 0 };
  }
  const rawText = clean(raw.raw, 160) || null;
  let iso: string | null = null;

  if (typeof raw.iso === 'string' && raw.iso.trim()) {
    const parsed = new Date(raw.iso);
    if (!Number.isNaN(parsed.getTime())) iso = parsed.toISOString();
  }

  // A model sometimes returns a date it read from the text rather than ISO.
  if (!iso && rawText) {
    const natural = new Date(rawText);
    if (!Number.isNaN(natural.getTime())) iso = natural.toISOString();
  }

  const kind: DeadlineDraft['kind'] =
    raw.kind === 'relative' || raw.kind === 'expiry' || raw.kind === 'explicit'
      ? raw.kind
      : 'explicit';

  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? clampConfidence(raw.confidence)
      : iso
        ? 0.6
        : 0;

  return { iso, raw: rawText, kind, confidence: iso ? confidence : 0 };
}

const FALLBACK_CATEGORY: AttentionCategory = 'requested_response';

/** Normalizes + validates one parsed object. Returns null when unusable. */
export function coerceVerdict(input: unknown): AIVerdict | null {
  const parsed = AI_VERDICT_SCHEMA.safeParse(input);
  if (!parsed.success) return null;
  const raw = parsed.data;

  // `is_attention_item` must be a real boolean. Models sometimes emit "yes".
  const isAttentionItem =
    typeof raw.is_attention_item === 'boolean'
      ? raw.is_attention_item
      : raw.is_attention_item === 'true';

  if (typeof isAttentionItem !== 'boolean') return null;

  const category = isAttentionCategory(raw.category) ? raw.category : FALLBACK_CATEGORY;
  const priority: Priority = isPriority(raw.priority) ? raw.priority : 'medium';

  const title = clean(raw.title, 160);
  const summary = clean(raw.summary, 500);
  const why = clean(raw.why_it_matters, 500);
  const action = clean(raw.recommended_action, 300);

  // An "attention item" with nothing to show the user is not usable.
  if (isAttentionItem && title.length === 0 && summary.length === 0) return null;

  return {
    isAttentionItem,
    category,
    priority,
    title,
    summary,
    whyItMatters: why,
    recommendedAction: action,
    deadline: coerceDeadline(raw.deadline),
    confidence: clampConfidence(raw.confidence),
  };
}

/**
 * Extracts a JSON object from arbitrary model output. Handles fenced blocks,
 * leading/trailing prose, and multiple candidate objects.
 */
export function extractJsonObject(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();

  // Prefer a fenced block if present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      const direct = JSON.parse(candidate);
      if (direct && typeof direct === 'object') return direct;
    } catch {
      // continue
    }

    // Balanced-brace scan from each opening brace.
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] !== '{') continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let j = i; j < candidate.length; j++) {
        const ch = candidate[j];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') inString = !inString;
        else if (!inString && ch === '{') depth++;
        else if (!inString && ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(candidate.slice(i, j + 1));
              if (parsed && typeof parsed === 'object') return parsed;
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return null;
}

/** Full pipeline: raw model text -> validated verdict, or null. */
export function parseModelResponse(text: string): AIVerdict | null {
  const obj = extractJsonObject(text);
  if (obj === null) return null;

  // Some models wrap the verdict in an envelope key.
  if (isAttentionCategory((obj as Record<string, unknown>).category)) {
    return coerceVerdict(obj);
  }
  const envelope = obj as Record<string, unknown>;
  for (const key of ['verdict', 'result', 'analysis', 'item', 'attention_item', 'data']) {
    const nested = envelope[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const coerced = coerceVerdict(nested);
      if (coerced) return coerced;
    }
  }
  return coerceVerdict(obj);
}

/**
 * Full pipeline for an already-parsed value (used by tests and by providers
 * that return structured output directly).
 */
export function validateStructured(value: unknown): AIVerdict | null {
  return coerceVerdict(value);
}

/** Normalizes arbitrary thrown values into a loggable shape. */
export function describeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message.slice(0, 300) };
  if (typeof err === 'string') return { name: 'Error', message: err.slice(0, 300) };
  return { name: 'UnknownError', message: 'non-error thrown' };
}

export type { NormalizedEmail, ThreadContext };
