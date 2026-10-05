import type {
  AIVerdict,
  AttentionCategory,
  DeadlineDraft,
  DeterministicVerdict,
  NormalizedEmail,
  Priority,
  Signal,
  ThreadContext,
} from '../domain/types.js';
import { emptyDeadline, toDeadline } from '../domain/types.js';
import {
  CATEGORY_PRIORITY_FLOOR,
  PRIORITY_ORDER,
  classifyCategory,
  normalizeDeadline,
  stricterPriority,
} from './categorize.js';
import { extractDeadline } from './deadlines.js';
import { extractSignals, hasKind, trimToWordBoundary } from './signals.js';
import { urgencyFromDeadline } from './resolve.js';
import { looksLikeBulkSender, makeExcerpt } from '../mail/normalize.js';

/**
 * Stage 6: produce the final verdict.
 *
 * Two inputs matter here:
 *   - the deterministic verdict (rules + thread context)
 *   - an optional AI verdict (semantics + wording)
 *
 * The merge is deliberately conservative: the AI can improve wording and
 * refine a category, but it cannot talk the engine into raising confidence or
 * inventing an obligation that no signal supports. If the AI says "important"
 * but the rules found nothing, the item stays suppressed.
 */

export interface MergeInput {
  rules: DeterministicVerdict;
  ai: AIVerdict | null;
  /** True when the AI's category disagrees with the rule category. */
  aiDisagrees: boolean;
  /** True when the AI agreed on both importance and category. */
  aiAgrees: boolean;
  /** Number of independent corroborating signal kinds. */
  independentSignals: number;
}

export function mergeVerdicts(input: MergeInput): AIVerdict {
  const { rules, ai, aiDisagrees, aiAgrees, independentSignals } = input;

  if (!ai) {
    return {
      isAttentionItem: rules.isAttentionItem,
      category: rules.category,
      priority: rules.priority,
      title: rules.title,
      summary: rules.summary,
      whyItMatters: rules.whyItMatters,
      recommendedAction: rules.recommendedAction,
      deadline: rules.deadline,
      confidence: rules.confidence,
    };
  }

  // Importance: rules are the gate. The AI may downgrade with strong wording but
  // never promote an item the rules suppressed.
  const isAttentionItem = rules.isAttentionItem || (ai.isAttentionItem && independentSignals >= 2);

  const category: AttentionCategory = rules.isAttentionItem
    ? (ai.category ?? rules.category)
    : rules.category;

  const floor = CATEGORY_PRIORITY_FLOOR[category] ?? 'low';
  const base = rules.isAttentionItem ? stricterPriority(rules.priority, ai.priority) : rules.priority;
  const priority: Priority = stricterPriority(floor, base);

  let confidence = rules.confidence;
  if (aiAgrees) confidence += 0.15;
  if (aiDisagrees) confidence -= 0.2;
  if (ai.confidence < 0.4) confidence -= 0.1;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    isAttentionItem,
    category,
    priority,
    title: pickText(ai.title, rules.title, 140),
    summary: pickText(ai.summary, rules.summary, 400),
    whyItMatters: pickText(ai.whyItMatters, rules.whyItMatters, 400),
    recommendedAction: pickText(ai.recommendedAction, rules.recommendedAction, 240),
    deadline: ai.deadline.iso ? ai.deadline : rules.deadline,
    confidence,
  };
}

function pickText(preferred: string, fallback: string, max: number): string {
  const clean = (preferred ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length >= 8) return clean.length > max ? `${clean.slice(0, max - 1).trim()}…` : clean;
  const fb = (fallback ?? '').replace(/\s+/g, ' ').trim();
  return fb.length > max ? `${fb.slice(0, max - 1).trim()}…` : fb;
}

/** Counts distinct signal kinds, excluding pure noise markers. */
export function countIndependentSignals(signals: Signal[]): number {
  const meaningful = signals.filter(
    (s) => !['bulk', 'marketing', 'social_notification', 'receipt_like', 'personal'].includes(s.kind),
  );
  const kinds = new Set(meaningful.map((s) => s.kind));
  return kinds.size;
}

export interface BuildVerdictInput {
  email: NormalizedEmail;
  context: ThreadContext;
  threadText: string;
  signals: Signal[];
  deadline: DeadlineDraft;
  now: Date;
}

/**
 * Builds the full deterministic verdict for one thread. This is where the
 * user-facing language is produced -- without any model involved -- so that
 * `AI_MODE=off` produces a genuinely complete product, not a degraded stub.
 */
export function buildDeterministicVerdict(input: BuildVerdictInput): DeterministicVerdict {
  const { email, context, signals, deadline, now } = input;
  const has = (kind: string) => hasKind(signals, kind as never);
  const bulkSender = looksLikeBulkSender(email.fromAddress);

  const text = `${email.subject}\n${email.bodyText}`;
  const { category, priority: categoryPriority } = classifyCategory({
    text,
    senderDomain: email.fromDomain,
    bulkSender,
    has,
  });

  const independentSignals = countIndependentSignals(signals);
  const urgency = urgencyFromDeadline(deadline.iso, now);

  // ---- is this an attention item at all? -----------------------------
  const obligation =
    has('action_request') || has('obligation') || has('security') || has('consequence');
  const actionableNoise = has('marketing') || has('bulk') || has('social_notification');

  const isAttentionItem =
    !actionableNoise &&
    (obligation || (has('deadline') && !has('automated_noop')));

  // ---- confidence ----------------------------------------------------
  // Evidence, not keyword volume. See PRODUCT_SPEC §5.
  let confidence = 0.3;
  if (!bulkSender) confidence += 0.2;
  if (obligation) confidence += 0.15;
  if (has('security')) confidence += 0.15;
  if (has('consequence')) confidence += 0.15;
  if (has('urgency')) confidence += 0.05;
  if (has('financial')) confidence += 0.05;
  if (deadline.iso) confidence += deadline.confidence * 0.1;
  if (has('question')) confidence += 0.05;
  confidence += Math.min(0.15, independentSignals * 0.03);
  if (has('automated_noop')) confidence -= 0.3;
  if (actionableNoise) confidence -= 0.35;
  if (bulkSender) confidence -= 0.15;
  // A single weak keyword never yields a high-confidence item.
  if (independentSignals <= 1) confidence = Math.min(confidence, 0.45);
  confidence = Math.max(0, Math.min(0.98, confidence));

  // ---- priority ------------------------------------------------------
  let priority: Priority = isAttentionItem ? categoryPriority : 'low';
  if (isAttentionItem) {
    if (has('security') || has('consequence')) priority = 'high';
    if (urgency === 'high') priority = 'high';
    else if (urgency === 'medium' && PRIORITY_ORDER[priority] < PRIORITY_ORDER.medium)
      priority = 'medium';
    if (has('automated_noop')) priority = 'low';
  }

  // ---- user-facing language -----------------------------------------
  const title = buildTitle(category, email);
  const summary = buildSummary(email, signals, deadline);
  const whyItMatters = buildWhyItMatters(category, signals, email);
  const recommendedAction = buildRecommendedAction(category, email, signals, deadline);

  return {
    isAttentionItem,
    category,
    priority,
    title,
    summary,
    whyItMatters,
    recommendedAction,
    deadline: normalizeDeadline(deadline, email.date),
    confidence,
    signals,
    suppressionReason: isAttentionItem ? null : buildSuppressionReason(signals, actionableNoise),
  };
}

function buildSuppressionReason(signals: Signal[], actionableNoise: boolean): string {
  if (hasKind(signals, 'automated_noop')) return 'Message states no action is required.';
  if (actionableNoise) return 'Bulk or promotional message with nothing requested.';
  if (hasKind(signals, 'announcement') && !hasKind(signals, 'action_request'))
    return 'Informational announcement with no request.';
  return 'No actionable request, obligation, or deadline detected.';
}

const CATEGORY_TITLES: Record<string, string> = {
  deadline: 'Deadline approaching',
  account_security: 'Security alert on your account',
  verification: 'Verification required',
  payment_action: 'Payment needs your attention',
  appointment: 'Appointment or schedule change',
  requirement: 'Requirement from your university or work',
  requested_response: 'Someone is waiting for your reply',
  personal: 'Important message from a person',
  service_interruption: 'Service disruption',
  expiring_item: 'Something you rely on is expiring',
  delivery_action: 'Delivery needs your attention',
  administrative: 'Administrative action required',
};

/**
 * A human title.
 *
 * Prefers the subject line, because that is the sender's own words and is what
 * the user will recognise. Falls back to a category phrase when the subject is
 * empty, too long, or reads like marketing.
 *
 * For multi-message threads the subject is kept but the message count is dropped
 * from it: the count is already implied by a single card, and it pushed the
 * useful part of the line past the display limit.
 */
function buildTitle(category: string, email: NormalizedEmail): string {
  const subject = stripReplyPrefix(email.subject).trim();
  const known = CATEGORY_TITLES[category];
  if (!known) return trimToWordBoundary(subject, 120) || known;

  if (subject.length >= 8 && subject.length <= 90 && !looksLikeSpammyTitle(subject)) {
    return subject;
  }
  return known;
}

function looksLikeSpammyTitle(subject: string): boolean {
  return (
    /[!]{2,}/.test(subject) ||
    /^(?:re|fwd|aw|sv|vs)\b/i.test(subject) ||
    /^[A-Z\s]{12,}$/.test(subject) ||
    /\b(?:deal|offer|sale|discount|save)\b/i.test(subject)
  );
}

function stripReplyPrefix(subject: string): string {
  return subject.replace(/^(?:(?:re|aw|sv|vs|fwd|fw|tr)\s*(?:\[\d+\])?\s*:\s*)+/i, '').trim();
}

function buildSummary(email: NormalizedEmail, signals: Signal[], deadline: DeadlineDraft): string {
  const body = makeExcerpt(email.bodyText, 260);
  if (body) return body;

  const parts: string[] = [];
  if (hasKind(signals, 'deadline') || deadline.raw) parts.push(`A deadline is mentioned: "${deadline.raw ?? 'deadline'}".`);
  if (hasKind(signals, 'question')) parts.push('The sender is asking a question that needs an answer.');
  if (parts.length === 0) parts.push(email.snippet || 'No readable body text was available.');
  return parts.join(' ');
}

function buildWhyItMatters(category: string, signals: Signal[], email: NormalizedEmail): string {
  const consequence = signals.find((s) => s.kind === 'consequence')?.evidence ?? '';
  if (consequence) {
    return `The sender states a consequence of not acting: "${truncate(consequence, 160)}"`;
  }

  const generic: Record<string, string> = {
    verification:
      'This kind of verification is often required before an account or service continues working.',
    account_security:
      'Unusual account activity can indicate that someone else has access. Reviewing it takes a minute.',
    payment_action:
      'A failed or overdue payment can incur fees or interrupt a service you rely on.',
    deadline:
      'A missed deadline in this context usually means a penalty, a rejected request, or a lost opportunity.',
    requirement:
      'Requirements from an institution or employer are usually mandatory, with consequences for missing them.',
    appointment:
      'A change to a scheduled time or place affects plans you have already made.',
    requested_response:
      'Someone is waiting on you, and the delay is visible to them.',
    expiring_item: 'Once this expires you may lose access, or need to pay to restore it.',
    delivery_action: 'A package that is stuck or misrouted will not resolve itself.',
    service_interruption:
      'An ongoing outage affects anything you were planning to do in that window.',
    administrative:
      'Administrative requests typically have a fixed window and are awkward to chase later.',
    personal: 'This looks like a direct message from someone who knows you.',
  };
  return generic[category] ?? 'This appears to require a decision or action from you.';
}

function buildRecommendedAction(
  category: string,
  email: NormalizedEmail,
  signals: Signal[],
  deadline: DeadlineDraft,
): string {
  const explicit = findActionPhrase(email.bodyText);
  if (explicit) return truncate(explicit, 200);

  const templates: Record<string, string> = {
    verification: 'Open the message and complete the verification steps.',
    account_security: 'Review the activity in your account and secure it if anything is unfamiliar.',
    payment_action: 'Check the payment status and settle the amount or update your payment method.',
    deadline: deadline.raw
      ? `Check the details and complete this before ${deadline.raw}.`
      : 'Review the details and respond before the deadline.',
    requirement: 'Open the message and complete the required step.',
    appointment: 'Open the message and confirm the new time or update your calendar.',
    requested_response: 'Reply to the sender with your decision.',
    personal: 'Read the message and reply if you need to.',
    expiring_item: 'Open the message and renew or update the item before it expires.',
    delivery_action: 'Open the tracking details and resolve the delivery issue.',
    service_interruption: 'Check the status page or wait for the next update.',
    administrative: 'Open the message and complete the requested form or update.',
  };

  if (hasKind(signals, 'question')) {
    return category === 'requested_response'
      ? 'Reply to the sender with your decision.'
      : 'Read the question in the message and respond if it applies to you.';
  }

  return templates[category] ?? 'Open the message and decide what to do.';
}

/** Fallback matcher, used only when no full sentence contains a request. */
const ACTION_PHRASE_RE =
  /\b(?:please\s+(?:confirm|verify|complete|submit|update|review|approve|respond|reply|sign|renew|register|provide|pay|upload|download|fill in|send)\b[^.!?\n]{0,140})/i;

/**
 * Trims a lifted action phrase to a complete thought.
 *
 * The match is allowed to run to 140 characters, which frequently cuts a
 * sentence mid-clause -- "Please complete identity verification for example" is
 * what you get from "for example.com". Backing off to a clause boundary keeps
 * the advice readable.
 */
function tidyActionPhrase(phrase: string): string {
  const original = phrase.replace(/\s+/g, ' ').trim();

  // Already a complete sentence: leave it alone.
  if (/[.!?]$/.test(original)) return original;

  // Prefer backing off to a clause boundary. Never strip the final word when it
  // is a real word -- only when the match was cut mid-word, which is detectable
  // because a truncated word is not a dictionary-ish ending. Being conservative
  // here matters more than brevity: "within 7 days" is not an improvement over
  // "within 7".
  const cut = (index: number): string =>
    original.slice(0, index).replace(/[\s,;:]+$/, '').trim();

  const lastComma = original.lastIndexOf(',');
  const lastClause = Math.max(
    original.lastIndexOf(' but '),
    original.lastIndexOf(' so '),
    original.lastIndexOf(' and then '),
  );
  if (lastClause > 20) return cut(lastClause);
  if (lastComma > 20) return cut(lastComma);

  // Ends on a preposition or conjunction: the sentence clearly continued.
  if (/\b(?:for|to|that|which|and|or|with|in|on|at|by|from)$/i.test(original)) {
    const words = original.split(' ');
    if (words.length > 4) return cut(original.length - words[words.length - 1].length);
  }

  return original.replace(/[\s,;:.]$/, '');
}

/**
 * Finds a phrase the sender addressed to the reader and requests action on.
 *
 * Sentences are extracted whole first, then phrases. Sentence extraction is
 * what keeps advice readable: an imperative like "Please submit your renewal
 * application before 13 October" is a complete thought, whereas slicing the same
 * text at a fixed character budget produces "…before 13 Octob".
 */
const ACTION_VERBS =
  'confirm|verify|complete|submit|update|review|approve|respond|reply|sign|renew|register|provide|pay|upload|download|fill in|send';

/**
 * "Please note that ..." states information rather than requesting an action,
 * so it is excluded: "please note that the deadline is unchanged" tells the user
 * something they already knew and gives them nothing to do.
 */
const ACTION_SENTENCE_RE = new RegExp(
  `[^.!?\\n]*\\b(?:please|kindly)\\s+(?:${ACTION_VERBS})\\b[^.!?]*[.!?]?`,
  'gi',
);

/**
 * Sentences that instruct without using "please", which is how many senders
 * write when the instruction is the entire point of the message.
 */
const IMPERATIVE_SENTENCE_RE = new RegExp(
  `[^.!?\\n]*\\b(?:you must|you are required to|you need to|make sure (?:that )?you)\\b[^.!?]*[.!?]?`,
  'gi',
);

/** Prefers the imperative phrasing: it states the obligation, not just a request. */
function findActionPhrase(body: string): string | null {
  const imperative = body.match(IMPERATIVE_SENTENCE_RE) ?? [];
  for (const sentence of imperative) {
    const cleaned = sentence.replace(/\s+/g, ' ').trim();
    if (cleaned.split(/\s+/).length >= 5) {
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
  }

  const sentences = body.match(ACTION_SENTENCE_RE) ?? [];

  // Longest first: the most specific instruction beats a passing mention.
  for (const sentence of sentences) {
    const cleaned = sentence.replace(/\s+/g, ' ').trim();
    if (cleaned.split(/\s+/).length >= 5) {
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
  }

  const m = ACTION_PHRASE_RE.exec(body);
  if (!m) return null;

  const phrase = tidyActionPhrase(m[0]);
  if (phrase.split(/\s+/).length < 4) return null;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

export { emptyDeadline, toDeadline };
