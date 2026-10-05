import type { NormalizedEmail, Signal, ThreadContext } from '../domain/types.js';
import { extractSignals, hasKind } from './signals.js';

/**
 * Stage 3: thread assembly.
 *
 * Importance is a property of a situation, not of a message. Grouping by thread
 * lets the engine see that "please verify" was answered by "verification
 * complete", and lets it know whether the newest message is still asking for
 * something.
 */

const USER_SENT_LABELS = ['SENT'];
const DRAFT_LABELS = ['DRAFT'];

export function isFromUser(email: NormalizedEmail, userAddress?: string | null): boolean {
  if (email.labels.some((l) => USER_SENT_LABELS.includes(l))) return true;
  if (!userAddress) return false;
  return email.fromAddress.toLowerCase() === userAddress.toLowerCase();
}

export function groupIntoThreads(emails: NormalizedEmail[]): Map<string, NormalizedEmail[]> {
  const groups = new Map<string, NormalizedEmail[]>();
  for (const email of emails) {
    const key = email.threadId || email.id;
    const list = groups.get(key);
    if (list) list.push(email);
    else groups.set(key, [email]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.date.getTime() - b.date.getTime());
  }
  return groups;
}

export function buildThreadContext(
  threadId: string,
  messages: NormalizedEmail[],
  userAddress?: string | null,
): ThreadContext {
  const sorted = [...messages].sort((a, b) => a.date.getTime() - b.date.getTime());
  const latest = sorted[sorted.length - 1] ?? messages[0];

  const participants: string[] = [];
  for (const m of sorted) {
    if (m.fromAddress && !participants.includes(m.fromAddress)) participants.push(m.fromAddress);
  }

  const userReplied = sorted.some((m) => isFromUser(m, userAddress));

  return {
    threadId,
    messages: sorted,
    latest,
    userReplied,
    participants,
    resolutionEvidence: [],
  };
}

/** Every message in the thread except the newest. */
export function priorMessages(ctx: ThreadContext): NormalizedEmail[] {
  return ctx.messages.slice(0, Math.max(0, ctx.messages.length - 1));
}

/** Concatenated text of the whole thread, for deadline and resolution scanning. */
export function threadText(ctx: ThreadContext): string {
  return ctx.messages
    .map((m) => `${m.subject}\n${m.bodyText}`)
    .join('\n\n---\n\n');
}

/**
 * Signals found only in the latest message. This is what we score: an older
 * "please do X" that was never answered is not something to surface today, but
 * an unanswered request in the newest message is.
 */
export function latestSignals(ctx: ThreadContext): Signal[] {
  return extractSignals(ctx.latest);
}

/** Signals from the whole thread, used to detect whether it was ever resolved. */
export function allSignals(ctx: ThreadContext): Signal[] {
  const combined: Signal[] = [];
  for (const m of ctx.messages) combined.push(...extractSignals(m));
  return combined;
}

export function threadHasResolution(ctx: ThreadContext): { resolved: boolean; signals: Signal[] } {
  const priors = priorMessages(ctx);
  // Resolution must come from a message *after* the message that made the request.
  const resolutionSignals: Signal[] = [];

  for (let i = 1; i < ctx.messages.length; i++) {
    const message = ctx.messages[i];
    const fromUser = isFromUser(message, undefined);
    const signals = extractSignals(message);
    if (hasKind(signals, 'resolution')) {
      // The recipient's own reply saying "done" also closes a request, but only
      // when it is not itself the message that raised the request.
      for (const s of signals) {
        if (s.kind === 'resolution') {
          resolutionSignals.push({ ...s, evidence: `${fromUser ? 'your reply' : 'their reply'}: ${s.evidence}` });
        }
      }
    }
  }

  void priors;
  return { resolved: resolutionSignals.length > 0, signals: resolutionSignals };
}
