import type { NormalizedEmail, Signal } from '../domain/types.js';
import { extractSignals, hasKind } from './signals.js';
import { looksLikeBulkSender } from '../mail/normalize.js';

/**
 * Stage 2: the cheap prefilter.
 *
 * This is the main cost control and the main precision control. An email is
 * rejected as noise when it carries *strong structural* evidence of bulk or
 * machine mail AND lacks any structural signal that it is asking something of
 * the user.
 *
 * The asymmetry is deliberate: noise must be provable, because a false negative
 * hides a real obligation. A single personal-looking, action-shaped, or
 * deadline-shaped signal always wins over the noise verdict.
 */

export type PrefilterDecision = 'skip_noise' | 'analyze';

export type NoiseCategory =
  | 'newsletter'
  | 'advertisement'
  | 'promotion'
  | 'receipt'
  | 'routine_notification'
  | 'informational'
  | 'spam';

export interface PrefilterResult {
  decision: PrefilterDecision;
  /** The non-noise category, when known cheaply. */
  category: NoiseCategory | null;
  confidence: number;
  reasons: string[];
  signals: Signal[];
}

interface NoiseProfile {
  /** Null when noise evidence was found but no specific category applies. */
  category: NoiseCategory | null;
  weight: number;
}

/**
 * Signals that can only come from a real obligation. If any is present the
 * email is never filtered out, no matter how strong the noise evidence is.
 */
function hasObligationEvidence(signals: Signal[]): boolean {
  return (
    hasKind(signals, 'action_request') ||
    hasKind(signals, 'obligation') ||
    hasKind(signals, 'security') ||
    hasKind(signals, 'question') ||
    hasKind(signals, 'consequence')
  );
}

function classifyNoise(email: NormalizedEmail, signals: Signal[]): NoiseProfile | null {
  const text = `${email.subject} ${email.bodyText}`;
  let weight = 0;
  const reasons: string[] = [];

  if (hasKind(signals, 'bulk')) {
    weight += 0.7;
    reasons.push('bulk-sender headers');
  }
  if (hasKind(signals, 'marketing')) {
    weight += 0.7;
    reasons.push('marketing language');
  }
  if (hasKind(signals, 'receipt_like')) {
    weight += 0.8;
    reasons.push('receipt/purchase-confirmation language');
  }
  if (hasKind(signals, 'social_notification')) {
    weight += 0.6;
    reasons.push('social-network notification');
  }

  const bulkSender = looksLikeBulkSender(email.fromAddress);
  if (bulkSender) {
    weight += 0.35;
    reasons.push('no-reply-style sender');
  }

  const words = email.bodyText.split(/\s+/).filter(Boolean).length;
  const isLongNewsletter = words > 350 && /newsletter|this week|weekly digest|issue #/i.test(text);

  if (email.subject.match(/\b(NEWSLETTER|Weekly|Issue #\d+|Digest)\b/i)) {
    weight += 0.5;
    reasons.push('newsletter subject pattern');
  }

  let category: NoiseCategory | null = null;
  if (isLongNewsletter || email.subject.match(/\bnewsletter|weekly digest/i)) {
    category = 'newsletter';
  } else if (hasKind(signals, 'marketing') || email.gmailCategory === 'CATEGORY_PROMOTIONS') {
    category = email.subject.match(/sale|off|offer|deal|discount|%/) ? 'advertisement' : 'promotion';
  } else if (hasKind(signals, 'receipt_like')) {
    category = 'receipt';
  } else if (hasKind(signals, 'social_notification')) {
    category = 'routine_notification';
  } else if (hasKind(signals, 'bulk') && bulkSender && !hasObligationEvidence(signals)) {
    category = 'informational';
  }

  if (category && weight >= 0.7) {
    return { category, weight: Math.min(weight, 1.6) };
  }

  // Long body from a bulk sender with no obligation language is a newsletter
  // even without the literal word.
  if (words > 500 && bulkSender && !hasObligationEvidence(signals)) {
    return { category: 'newsletter', weight: Math.min(weight + 0.4, 1.5) };
  }

  return { category, weight };
}

export function prefilter(email: NormalizedEmail): PrefilterResult {
  const signals = extractSignals(email);

  // Hard pass: obligation evidence always survives.
  if (hasObligationEvidence(signals)) {
    return {
      decision: 'analyze',
      category: null,
      confidence: 0.9,
      reasons: ['obligation evidence present'],
      signals,
    };
  }

  // Classify first, so a receipt is recorded as a receipt rather than as a
  // generic "informational" just because it also said no action was needed.
  const noise = classifyNoise(email, signals);
  if (noise?.category) {
    return {
      decision: 'skip_noise',
      category: noise.category,
      confidence: Math.min(0.95, 0.5 + noise.weight * 0.3),
      reasons: [noise.category, ...(noise.weight >= 0.7 ? [] : ['weak evidence'])],
      signals,
    };
  }

  // Automated no-action mail is not an attention item even without bulk headers.
  if (hasKind(signals, 'automated_noop')) {
    return {
      decision: 'skip_noise',
      category: 'informational',
      confidence: 0.75,
      reasons: ['explicitly requires no action'],
      signals,
    };
  }

  return {
    decision: 'analyze',
    category: null,
    confidence: 0.5,
    reasons: ['no noise evidence'],
    signals,
  };
}

/** Batch helper: returns only the emails worth deeper analysis. */
export function partitionBySignal(emails: NormalizedEmail[]): {
  analyze: NormalizedEmail[];
  skipped: { email: NormalizedEmail; result: PrefilterResult }[];
} {
  const analyze: NormalizedEmail[] = [];
  const skipped: { email: NormalizedEmail; result: PrefilterResult }[] = [];
  for (const email of emails) {
    const result = prefilter(email);
    if (result.decision === 'analyze') analyze.push(email);
    else skipped.push({ email, result });
  }
  return { analyze, skipped };
}
