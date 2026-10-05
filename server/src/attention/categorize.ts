import type { AttentionCategory, DeadlineDraft, Priority } from '../domain/types.js';

/**
 * Category classification from typed signals.
 *
 * Rules are ordered by specificity, so a "domain verification required" email
 * lands in `verification` rather than the generic `account_security`, and a
 * failed payment lands in `payment_action` rather than `financial`.
 */

interface CategoryRule {
  category: AttentionCategory;
  priority: Priority;
  test: (ctx: ClassifyContext) => boolean;
}

export interface ClassifyContext {
  text: string;
  senderDomain: string;
  bulkSender: boolean;
  has: (kind: string) => boolean;
}

const CATEGORY_RULES: CategoryRule[] = [
  // ---- verification (before the broader security rules) ---------------
  {
    category: 'verification',
    priority: 'high',
    test: (c) =>
      /(?:identity verification|verify your (?:identity|account|domain|email|phone|address)|registrant verification|domain verification|proof of identity|kyc|verify (?:that )?you|verify your identity|verification required|identity check)/i.test(
        c.text,
      ) && !c.bulkSender,
  },
  // ---- account / security -------------------------------------------
  {
    category: 'account_security',
    priority: 'high',
    test: (c) =>
      c.has('security') &&
      /(?:password|sign-?in|log-?in|device|activity|suspicious|compromised|unauthori[sz]ed|2fa|two[- ]factor|security|breach|locked|disabled|suspend)/i.test(
        c.text,
      ),
  },
  {
    category: 'account_security',
    priority: 'high',
    test: (c) =>
      c.has('consequence') &&
      /(?:account|access|domain|subscription|registration|mailbox|profile) (?:will be|may be|has been) (?:suspend|deactivat|clos|delet|lock|disabl|remov|terminat|expir)/i.test(
        c.text,
      ),
  },
  // ---- payment -------------------------------------------------------
  {
    category: 'payment_action',
    priority: 'high',
    test: (c) =>
      /(?:payment (?:failed|declined|reversed|required|due|overdue|pending)|(?:failed|declined|overdue) (?:payment|charge|transaction)|charge failed|invoice (?:is )?(?:due|overdue)|outstanding balance|balance due|pay(?:ment)? (?:is )?required|autopay)/i.test(
        c.text,
      ) && !/(?:receipt for your purchase|order confirmation)/i.test(c.text),
  },
  // ---- expiring ------------------------------------------------------
  {
    category: 'expiring_item',
    priority: 'medium',
    test: (c) =>
      /(?:expire[sd]?|expiring|renewal|lapses|valid (?:until|through)|runs? out|passport|driver'?s licen[cs]e|visa|permit|certification)/i.test(
        c.text,
      ) && !c.has('appointment'),
  },
  // ---- appointment ---------------------------------------------------
  {
    category: 'appointment',
    priority: 'medium',
    test: (c) =>
      /(?:appointment|scheduled (?:for|at)|booking (?:confirmed|rescheduled)|rescheduled|moved to|clinic|doctor'?s|dentist|interview (?:scheduled|at)|meeting (?:at|on|time)|conference call|webinar (?:on|at)|calendar (?:invite|invitation)|rsvp)/i.test(
        c.text,
      ),
  },
  // ---- delivery ------------------------------------------------------
  {
    category: 'delivery_action',
    priority: 'medium',
    test: (c) =>
      /(?:customs|held at|delivery (?:attempt|failed|rescheduled)|could not be delivered|missing (?:from|address)|wrong address|redirect (?:your )?parcel|pick ?up|collection point|signature required)/i.test(
        c.text,
      ),
  },
  // ---- service interruption -----------------------------------------
  {
    category: 'service_interruption',
    priority: 'high',
    test: (c) =>
      /(?:outage|downtime|service (?:is )?(?:unavailable|down|degraded)|maintenance (?:window|scheduled)|planned maintenance|we (?:are )?(?:investigating|aware of an? (?:issue|outage))|temporarily (?:unavailable|offline)|degraded performance)/i.test(
        c.text,
      ),
  },
  // ---- academic / work requirement ----------------------------------
  {
    category: 'requirement',
    priority: 'high',
    test: (c) =>
      /(?:assignment|submission|homework|project|presentation|deadline|grade|exam|enrol?l?ment|registration|transcript|requirement|mandatory|compulsory|tuition|academic|proposal|timesheet|payroll|onboarding|policy (?:update|acknowledg))/i.test(
        c.text,
      ) && (c.has('deadline') || c.has('obligation') || c.has('action_request')),
  },
  // ---- deadline (generic) -------------------------------------------
  {
    category: 'deadline',
    priority: 'high',
    test: (c) => c.has('deadline') && (c.has('obligation') || c.has('action_request')),
  },
  // ---- requested response -------------------------------------------
  {
    category: 'requested_response',
    priority: 'medium',
    test: (c) =>
      c.has('question') &&
      (c.has('action_request') || /(?:let me know|could you|can you|would you|are you available|do you (?:have|want)|your (?:availability|opinion|input|feedback|thoughts)|reply|respond)/i.test(c.text)),
  },
  {
    category: 'requested_response',
    priority: 'medium',
    test: (c) =>
      /(?:awaiting your reply|waiting (?:on|for) your (?:reply|response|answer)|following up (?:on|with)|gentle reminder|bumping this)/i.test(
        c.text,
      ),
  },
  // ---- administrative ------------------------------------------------
  {
    category: 'administrative',
    priority: 'medium',
    test: (c) =>
      /(?:tax (?:return|filing|form)|form (?:w-?\d|requires?)|visa application|passport renewal|driving licen[cs]e|bank statement|please provide|proof of|bill(?:ing)? address|verify your (?:address|details|information)|update your (?:records|details|address|profile))/i.test(
        c.text,
      ),
  },
  // ---- personal ------------------------------------------------------
  {
    category: 'personal',
    priority: 'medium',
    test: (c) => c.has('personal') && !c.bulkSender && c.text.length > 0,
  },
];

export function classifyCategory(ctx: ClassifyContext): {
  category: AttentionCategory;
  priority: Priority;
} {
  for (const rule of CATEGORY_RULES) {
    try {
      if (rule.test(ctx)) return { category: rule.category, priority: rule.priority };
    } catch {
      // A malformed rule must not take down the analysis.
    }
  }
  return { category: 'requested_response', priority: 'low' };
}

/** Priority floor per category, used when merging an AI verdict with rules. */
export const CATEGORY_PRIORITY_FLOOR: Record<string, Priority> = {
  account_security: 'high',
  verification: 'high',
  payment_action: 'high',
  service_interruption: 'high',
  deadline: 'high',
  delivery_action: 'medium',
  appointment: 'medium',
  requirement: 'high',
  administrative: 'medium',
  expiring_item: 'medium',
  requested_response: 'medium',
  personal: 'low',
};

export const PRIORITY_ORDER: Record<Priority, number> = { low: 1, medium: 2, high: 3 };

export function stricterPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_ORDER[a] >= PRIORITY_ORDER[b] ? a : b;
}

/** Nudges a deadline date forward off an obviously stale date. */
export function normalizeDeadline(draft: DeadlineDraft, anchor: Date): DeadlineDraft {
  if (!draft.iso) return draft;
  const parsed = Date.parse(draft.iso);
  if (Number.isNaN(parsed)) return { ...draft, iso: null, confidence: 0 };
  if (draft.kind === 'explicit' && parsed < anchor.getTime() - 365 * 24 * 3_600_000) {
    return { ...draft, iso: null, raw: draft.raw, confidence: 0 };
  }
  return draft;
}
