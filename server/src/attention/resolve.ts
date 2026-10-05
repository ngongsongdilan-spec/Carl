import type {
  DeterministicVerdict,
  NormalizedEmail,
  Priority,
  ThreadContext,
} from '../domain/types.js';
import { hasKind } from './signals.js';
import { isDeadlinePassed } from './deadlines.js';
import { extractSignals, hasKind as signalsHaveKind, trimToWordBoundary } from './signals.js';

/**
 * Stage 5: suppression.
 *
 * An attention item is a live obligation. Three things mean there is no live
 * obligation any more:
 *
 *   1. the thread was resolved (a later message says it's done)
 *   2. the user already replied to the thread
 *   3. the deadline has passed
 *
 * In all three cases the item is still *recorded* -- with a reason -- but it
 * never appears as an open attention item. That distinction matters: an audit
 * trail of "this was suppressed because the deadline passed on 3 Oct" is much
 * more useful than silently forgetting it.
 */

export type SuppressionReason =
  | 'resolved_in_thread'
  | 'already_replied'
  | 'deadline_passed'
  | 'noise'
  | 'low_confidence'
  | 'below_threshold'
  | 'no_action_required'
  | 'duplicate';

export interface Suppression {
  suppressed: true;
  reason: SuppressionReason;
  detail: string;
}

export function notSuppressed(): null {
  return null;
}

export interface ResolveInput {
  context: ThreadContext;
  signals: ReturnType<typeof extractSignals>;
  deadlineIso: string | null;
  deadlineRaw: string | null;
  now: Date;
  userAddress?: string | null;
}

/**
 * Returns a suppression when there is no live obligation, else null.
 * Order matters: resolution beats "you already replied", because a reply does
 * not necessarily mean the issue is closed.
 */
export function resolveSuppression(input: ResolveInput): Suppression | null {
  const { context, signals, deadlineIso, deadlineRaw, now } = input;

  // 1. No action required at all.
  if (signalsHaveKind(signals, 'automated_noop') && !signalsHaveKind(signals, 'security')) {
    return {
      suppressed: true,
      reason: 'no_action_required',
      detail: 'The message states that no action is required.',
    };
  }

  // 2. The thread resolved itself.
  const resolutionSignals = collectResolutionSignals(context);
  if (resolutionSignals.length > 0) {
    return {
      suppressed: true,
      reason: 'resolved_in_thread',
      detail: `Resolved in a later message in the same thread: "${firstEvidence(resolutionSignals)}"`,
    };
  }

  // 3. The user replied in this thread after the request.
  if (input.userAddress && context.userReplied && !isLatestFromOtherParty(context, input.userAddress)) {
    return {
      suppressed: true,
      reason: 'already_replied',
      detail: 'You have already replied in this thread.',
    };
  }

  // 4. The deadline has passed.
  if (deadlineIso && isDeadlinePassed(deadlineIso, now)) {
    return {
      suppressed: true,
      reason: 'deadline_passed',
      detail: deadlineRaw
        ? `The deadline has passed ("${deadlineRaw}").`
        : 'The deadline has passed.',
    };
  }

  // 5. Explicitly withdraws the request.
  if (/\b(?:ignore|disregard) (?:my |the |our )?(?:previous|earlier|last|prior)\b/i.test(context.latest.bodyText)) {
    return {
      suppressed: true,
      reason: 'resolved_in_thread',
      detail: 'The latest message withdraws the earlier request.',
    };
  }

  void hasKind;
  return null;
}

function isLatestFromOtherParty(ctx: ThreadContext, userAddress: string): boolean {
  return ctx.latest.fromAddress.toLowerCase() !== userAddress.toLowerCase();
}

function collectResolutionSignals(ctx: ThreadContext): ReturnType<typeof extractSignals> {
  const found: ReturnType<typeof extractSignals> = [];
  for (let i = 1; i < ctx.messages.length; i++) {
    const message = ctx.messages[i];
    for (const signal of extractSignals(message)) {
      if (signal.kind === 'resolution') {
        found.push({
          ...signal,
          evidence: `${message.fromAddress}: ${signal.evidence}`.trim(),
        });
      }
    }
  }
  return found;
}

function firstEvidence(signals: { evidence: string }[]): string {
  return trimToWordBoundary(signals[0]?.evidence ?? 'resolution marker', 120);
}

/**
 * Urgency derived from how close a deadline is. Returns null when there is no
 * deadline, so that priority is never inflated by speculation.
 */
export function urgencyFromDeadline(deadlineIso: string | null, now: Date): Priority | null {
  if (!deadlineIso) return null;
  const ms = Date.parse(deadlineIso);
  if (Number.isNaN(ms)) return null;
  const diff = ms - now.getTime();
  const hours = diff / 3_600_000;
  if (hours < 0) return null;
  if (hours <= 48) return 'high';
  if (hours <= 24 * 7) return 'medium';
  return 'low';
}

export function suppressNoiseEmail(
  email: NormalizedEmail,
  category: string,
): DeterministicVerdict {
  return {
    isAttentionItem: false,
    category: (category as DeterministicVerdict['category']) ?? 'informational',
    priority: 'low',
    title: trimToWordBoundary(email.subject, 120) || '(no subject)',
    summary: '',
    whyItMatters: '',
    recommendedAction: '',
    deadline: { iso: null, raw: null, kind: 'explicit', confidence: 0 },
    confidence: 0.2,
    signals: [],
    suppressionReason: category,
  };
}
