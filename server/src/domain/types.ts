/**
 * Core domain types for the attention engine.
 *
 * These describe the *internal* representation. The public API shape lives in
 * `AttentionItemView` which is a projection safe to send to a browser.
 */

export type Priority = 'high' | 'medium' | 'low';

export const ACTIONABLE_CATEGORIES = [
  'deadline',
  'account_security',
  'verification',
  'payment_action',
  'appointment',
  'requirement',
  'requested_response',
  'personal',
  'service_interruption',
  'expiring_item',
  'delivery_action',
  'administrative',
] as const;

export const NON_ACTIONABLE_CATEGORIES = [
  'newsletter',
  'advertisement',
  'promotion',
  'receipt',
  'routine_notification',
  'informational',
  'spam',
  'other',
] as const;

export type ActionableCategory = (typeof ACTIONABLE_CATEGORIES)[number];
export type NonActionableCategory = (typeof NON_ACTIONABLE_CATEGORIES)[number];
export type AttentionCategory = ActionableCategory | NonActionableCategory;

const CATEGORY_SET: ReadonlySet<string> = new Set<string>([
  ...ACTIONABLE_CATEGORIES,
  ...NON_ACTIONABLE_CATEGORIES,
]);

export function isActionableCategory(c: AttentionCategory): c is ActionableCategory {
  return (ACTIONABLE_CATEGORIES as readonly string[]).includes(c);
}

export function isAttentionCategory(value: unknown): value is AttentionCategory {
  return typeof value === 'string' && CATEGORY_SET.has(value);
}

export function isPriority(value: unknown): value is Priority {
  return value === 'high' || value === 'medium' || value === 'low';
}

export function clampConfidence(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0.5;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return Math.round(v * 1000) / 1000;
}

/** A date extracted from email text, kept structured so the UI can be honest about it. */
export interface Deadline {
  /** ISO-8601 date/time, resolved against the message's own timestamp. */
  iso: string;
  /** The exact text the deadline was read from, for display and debugging. */
  raw: string;
  kind: 'explicit' | 'relative' | 'expiry';
  confidence: number;
}

export interface DeadlineDraft {
  iso: string | null;
  raw: string | null;
  kind: Deadline['kind'];
  confidence: number;
}

export function emptyDeadline(): DeadlineDraft {
  return { iso: null, raw: null, kind: 'explicit', confidence: 0 };
}

export function toDeadline(d: DeadlineDraft | null | undefined): Deadline | null {
  if (!d || !d.iso) return null;
  return {
    iso: d.iso,
    raw: d.raw ?? '',
    kind: d.kind,
    confidence: Math.max(0, Math.min(1, d.confidence)),
  };
}

/**
 * A single normalized message. Everything downstream reads only this shape, so
 * the engine is completely decoupled from Gmail (or any other mail provider).
 */
export interface NormalizedEmail {
  id: string;
  threadId: string;
  subject: string;
  fromName: string | null;
  fromAddress: string;
  fromDomain: string;
  to: string[];
  cc: string[];
  snippet: string;
  bodyText: string;
  /** True when we extracted the body from an HTML part. */
  bodyWasHtml: boolean;
  date: Date;
  labels: string[];
  /** Gmail's own category hint. Used as a weak signal, never as a verdict. */
  gmailCategory: string | null;
  /** Header-derived bulk markers. Structural evidence of non-personal mail. */
  listUnsubscribe: boolean;
  listId: string | null;
  precedence: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
}

/** Typed, explainable evidence extracted by the rule layer. */
export type SignalKind =
  | 'action_request'
  | 'question'
  | 'obligation'
  | 'deadline'
  | 'urgency'
  | 'consequence'
  | 'financial'
  | 'security'
  | 'expiry'
  | 'resolution'
  | 'personal'
  | 'automated_noop'
  | 'bulk'
  | 'marketing'
  | 'social_notification'
  | 'receipt_like'
  | 'announcement';

export interface Signal {
  kind: SignalKind;
  /** Which text triggered it. Truncated; used for explainability, not stored. */
  evidence: string;
  /** -1 (mitigating) .. +1 (aggravating) contribution to importance. */
  weight: number;
}

export interface ThreadContext {
  threadId: string;
  messages: NormalizedEmail[];
  /** The newest message in the thread. */
  latest: NormalizedEmail;
  /** True when the user has already replied within this thread. */
  userReplied: boolean;
  participants: string[];
  /** Messages that appear to close the thread's request. */
  resolutionEvidence: Signal[];
}

export interface DeterministicVerdict {
  isAttentionItem: boolean;
  category: AttentionCategory;
  priority: Priority;
  title: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  deadline: DeadlineDraft;
  confidence: number;
  signals: Signal[];
  /** Non-empty when the item was suppressed; shown in the UI audit trail. */
  suppressionReason: string | null;
}

/** What an AIProvider must return for a thread. Already validated. */
export interface AIVerdict {
  isAttentionItem: boolean;
  category: AttentionCategory;
  priority: Priority;
  title: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  deadline: DeadlineDraft;
  confidence: number;
}

export type ItemStatus = 'open' | 'handled' | 'dismissed' | 'resolved';

/** Persisted attention item. */
export interface AttentionItem {
  id: string;
  eventKey: string;
  threadId: string | null;
  sourceMessageId: string;
  sourceThreadId: string | null;
  category: AttentionCategory;
  priority: Priority;
  confidence: number;
  title: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  deadlineIso: string | null;
  deadlineRaw: string | null;
  status: ItemStatus;
  resolvedReason: string | null;
  /** 'rules' | 'ai' | 'hybrid' */
  decidedBy: string;
  createdAt: string;
  updatedAt: string;
  notifiedAt: string | null;
}

/** Projection sent to the browser. Contains no email body and no secrets. */
export interface AttentionItemView {
  id: string;
  priority: Priority;
  category: AttentionCategory;
  title: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  deadline: Deadline | null;
  confidence: number;
  status: ItemStatus;
  sourceMessageId: string;
  sourceThreadId: string | null;
  /** Deep link that opens the message in Gmail. Safe: constructed, not echoed. */
  gmailUrl: string;
  source: {
    sender: string;
    subject: string;
    receivedAt: string;
    /** Truncated plain-text excerpt. Rendered as text by the client. */
    excerpt: string;
  };
  createdAt: string;
  updatedAt: string;
  decidedBy: string;
}
