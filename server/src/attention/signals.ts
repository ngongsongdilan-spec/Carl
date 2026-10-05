import type { NormalizedEmail, Signal, SignalKind } from '../domain/types.js';
import { looksLikeBulkSender, signalText } from '../mail/normalize.js';

/**
 * Typed, explainable evidence extraction.
 *
 * Every rule is a pure function over text with a fixed weight. Nothing here
 * produces a final verdict -- `score.ts` combines the signals. Keeping them
 * separate is what makes the engine debuggable: you can ask "why was this
 * important?" and get the actual list of reasons.
 */

interface Rule {
  kind: SignalKind;
  weight: number;
  pattern: RegExp;
  /** Only evaluate when this passes. Used for contextual rules. */
  when?: (ctx: Context) => boolean;
}

interface Context {
  text: string;
  subject: string;
  body: string;
  email: NormalizedEmail;
  wordCount: number;
}

const QUESTION_RE = /[?？]/;

/**
 * Phrases where an obligation-shaped word is negated. Checked before the
 * obligation rule so "nothing is required from you" is not read as a demand.
 */
const NEGATED_OBLIGATION =
  /\b(?:nothing|no|not|never)\s+(?:else\s+)?(?:is|are|will be\s+)?(?:required|needed|need|necessary|obligatory)\b|\bno action (?:is )?(?:required|needed|necessary)\b|\bnothing (?:is )?required\b|\bdo(?:es)? not (?:need|have to) do anything\b|\bif you do not\b/i;

/**
 * Signals that must defeat a blanket "no action needed" reading.
 *
 * A security alert legitimately contains the reassurance "if this was you, no
 * action is required" alongside a real obligation. When obligation evidence
 * exists, the no-op reading is the wrong one, so it is dropped.
 */
const NOOP_DEFEATED_BY: SignalKind[] = ['security', 'obligation', 'action_request', 'consequence'];
const URGENCY_WORDS =
  /\b(urgent|immediately|asap|right away|final notice|act now|time[- ]sensitive|expires? (?:today|soon)|last chance|attorney|hurry)\b/i;

const RULES: Rule[] = [
  // ---- direct requests -------------------------------------------------
  {
    kind: 'action_request',
    weight: 0.9,
    pattern:
      /\b(?:please\s+(?:confirm|verify|complete|submit|update|review|approve|respond|reply|sign|renew|register|provide|pay|check)|kindly\s+\w+|you (?:must|need to|are required to|have to)\s+\w+|we(?:'re| are) (?:requesting|asking)|(?:could|can) you (?:please\s+)?\w+)\b/i,
  },
  {
    kind: 'action_request',
    weight: 0.7,
    pattern:
      /\b(?:action (?:is )?required|requires? (?:your|immediate) (?:action|attention|response|approval|confirmation)|awaiting your (?:response|reply|approval)|pending your (?:action|approval|response)|to continue[,.]?\s+(?:please|you)|requires? (?:verification|confirmation|approval))\b/i,
  },
  {
    kind: 'action_request',
    weight: 0.6,
    pattern:
      /\b(?:please\s+(?:note|be aware|review|complete|fill|bring|send|upload|download|use|follow|check|read)|don'?t forget to|make sure to (?:complete|submit|verify|reply)|ensure that you)\b/i,
  },
  // ---- obligation ------------------------------------------------------
  // Negation matters: "Nothing is required from you" and "no action is required"
  // are the opposite of an obligation, and are extremely common in exactly the
  // informational mail this engine must not flag.
  {
    kind: 'obligation',
    weight: 0.9,
    pattern:
      /\b(?:you must|you are required to|you need to|it is (?:mandatory|required|essential)|(?:^|[.\n])\s*(?:it|this) is mandatory|is mandatory|is required|non[- ]negotiable|by order of|failure to (?:comply|respond|act|do so))\b/i,
    when: (ctx) => !NEGATED_OBLIGATION.test(ctx.text),
  },
  {
    kind: 'obligation',
    weight: 0.7,
    pattern:
      /\b(?:all (?:students|employees|members|applicants|users|tenants) (?:must|are required|should)|it is your (?:responsibility|obligation) to|under (?:regulation|policy|contract|terms))\b/i,
  },
  // ---- urgency / consequence -----------------------------------------
  { kind: 'urgency', weight: 0.6, pattern: URGENCY_WORDS },
  {
    kind: 'consequence',
    weight: 1,
    pattern:
      /\b(?:will be (?:suspended|closed|deactivated|terminated|cancelled|canceled|deleted|locked|disabled|removed|banned)|(?:account|access|service|domain|website|subscription|registration|number) (?:will be|may be|is|are) (?:suspended|deactivated|closed|cancelled|canceled|deleted|locked|disabled|removed|expire[sd]?|terminated)|risk of (?:data loss|fraud|penalt\w+|loss)|could be (?:charged|fined|suspended|deleted)|you will lose access)\b/i,
  },
  {
    kind: 'consequence',
    weight: 0.8,
    pattern:
      /\b(?:before we can|cannot (?:be )?(?:process|complete|ship|deliver|issue|activate|process your)|will not be (?:processed|shipped|delivered|issued)|we (?:cannot|can'?t|are unable to) (?:process|complete|issue|release))\b/i,
  },
  // ---- money ----------------------------------------------------------
  {
    kind: 'financial',
    weight: 0.9,
    pattern:
      /\b(?:payment (?:failed|due|overdue|required|pending|declined)|(?:failed|declined|overdue) (?:payment|charge|transaction)|amount (?:due|owed)|outstanding balance|invoice (?:is )?(?:due|overdue|payable)|due (?:by|on)|balance due|charge failed|payment (?:was )?(?:declined|reversed))\b/i,
  },
  {
    kind: 'financial',
    weight: 0.6,
    pattern:
      /(?:[$€£]\s?\d[\d,.]*|USD|EUR|GBP)\b/,
  },
  // ---- security -------------------------------------------------------
  {
    kind: 'security',
    weight: 1,
    pattern:
      /\b(?:new (?:sign-?in|login)|(?:signed|logged) in from|unusual (?:sign-?in|login|activity)|suspicious (?:activity|login|sign-?in)|password (?:was |has been )?(?:changed|reset|updated)|new device|failed (?:sign-?in|login) attempt|multi[- ]factor|2fa|verify (?:it'?s |this is )?you|security alert|compromised|unauthori[sz]ed access|we detected)\b/i,
  },
  {
    kind: 'security',
    weight: 0.8,
    pattern:
      /\b(?:verify your (?:email address|account|identity|phone)|identity verification|verify (?:your|your account|the) (?:identity|account|domain)|domain verification|registrant verification|proof of (?:identity|ownership)|two[- ]factor (?:authentication|verification)|enable 2fa)\b/i,
  },
  // ---- expiry ---------------------------------------------------------
  {
    kind: 'expiry',
    weight: 0.8,
    pattern:
      /\b(?:expire[sd]?(?:s|ing)? (?:on|in|at|by)?|valid (?:only )?(?:until|through)|expires? on|expiring (?:soon|now|on)|renewal (?:due|date|window)|renew by|expires? in \d+)\b/i,
  },
  // ---- resolution -----------------------------------------------------
  {
    kind: 'resolution',
    weight: 0.8,
    pattern:
      /\b(?:all set|is (?:now )?complete|has been (?:completed|resolved|processed|approved|verified|confirmed|updated|cancelled|canceled|fixed|activated)|we (?:have )?(?:completed|resolved|processed|approved|verified|confirmed)|verification (?:is )?complete|no (?:further )?action (?:is )?required|nothing (?:else )?to do|you'?re (?:all )?set|issue (?:has been )?resolved|resolved (?:it|this)|payment (?:has been )?received)\b/i,
  },
  {
    kind: 'resolution',
    weight: 0.7,
    pattern:
      /\b(?:(?:thanks|thank you)[^.\n]{0,40}\b(?:that worked|for your help|all sorted)\b|didn'?t need (?:any|your) help|never mind[,.]? |disregard (?:my|the|our) (?:last|previous)|ignore (?:my|the) (?:last|previous|earlier))\b/i,
  },
  {
    kind: 'resolution',
    weight: 0.6,
    pattern:
      /^\s*(?:thanks|thank you|perfect|great|done|got it|received|understood)[.!.\s]*$/im,
  },
  // ---- automated no-op ------------------------------------------------
  {
    kind: 'automated_noop',
    weight: 0.7,
    // Conditional phrasing ("if this was you, no action is required") is
    // deliberately excluded: the message states both branches, and only one of
    // them may apply. Treating the reassurance as the conclusion would hide a
    // real security alert.
    pattern:
      /\b(?:no action (?:is )?(?:required|needed|necessary)|this (?:is an? )?(?:automated|informational) (?:notification|message)|you are receiving this (?:email|message) (?:because|to)|your (?:order|package|shipment|delivery|purchase|payment) (?:has been|was|is) (?:confirmed|scheduled|placed|processed|dispatched)|receipt (?:for|of) your (?:purchase|order|payment)|nothing (?:is )?required from you|no (?:further )?action (?:is )?(?:required|needed))\b/i,
    when: (ctx) => !/if (?:this|you) (?:was|were|did|do)\b/i.test(ctx.text),
  },
  {
    kind: 'automated_noop',
    weight: 0.6,
    pattern:
      /\b(?:tracking (?:number|details)|your (?:order|parcel) (?:has|was) (?:shipped|delivered)|out for delivery|delivered on)\b/i,
    when: (ctx) => looksLikeBulkSender(ctx.email.fromAddress),
  },
  // ---- bulk / marketing ----------------------------------------------
  { kind: 'bulk', weight: 0.8, pattern: /^$/, when: (ctx) => ctx.email.listUnsubscribe },
  { kind: 'bulk', weight: 0.7, pattern: /^$/, when: (ctx) => ctx.email.listId !== null },
  {
    kind: 'bulk',
    weight: 0.7,
    pattern: /^$/,
    when: (ctx) => ctx.email.precedence === 'bulk' || ctx.email.precedence === 'list',
  },
  {
    kind: 'bulk',
    weight: 0.6,
    pattern: /^$/,
    when: (ctx) => ctx.email.gmailCategory === 'CATEGORY_PROMOTIONS',
  },
  {
    kind: 'bulk',
    weight: 0.6,
    pattern: /^$/,
    when: (ctx) => ctx.email.labels.includes('CATEGORY_PROMOTIONS'),
  },
  {
    kind: 'bulk',
    weight: 0.5,
    pattern: /^$/,
    when: (ctx) => ctx.email.gmailCategory === 'CATEGORY_SOCIAL',
  },
  {
    kind: 'marketing',
    weight: 0.8,
    pattern:
      /\b(?:unsubscribe|sign up|shop now|limited time offer|shop sale|%[a-z]*off[a-z]*%|best deals|coupon|promo code|limited offer|click here to (?:shop|claim)|black friday|cyber monday|new arrivals|flash sale|free trial|upgrade your plan)\b/i,
  },
  {
    kind: 'social_notification',
    weight: 0.6,
    pattern:
      /\b(?:(has )?(?:liked|commented|shared|tagged|mentioned|followed|invited) (?:your|you)|new (?:followers?|connection|friend request)|someone (?:viewed|visited) your profile)\b/i,
  },
  // ---- receipts -------------------------------------------------------
  {
    kind: 'receipt_like',
    weight: 0.8,
    pattern:
      /\b(?:(?:receipt|invoice|order confirmation|payment confirmation|purchase receipt|acknowledgement of (?:payment|order)|your (?:order|purchase|payment) (?:confirmation|receipt)|thanks for your (?:purchase|payment|order))\b)/i,
  },
  // ---- announcements --------------------------------------------------
  {
    kind: 'announcement',
    weight: 0.5,
    pattern:
      /\b(?:(?:please be advised|we'?re (?:pleased|excited|happy) to announce|announcing|is now (?:live|available|open)|we have (?:launched|released|updated))\b)/i,
  },
  {
    // "Dear Dr Mensah" is a person addressing someone by name. A bare
    // "hi"/"hello" is deliberately excluded: every newsletter opens with one.
    kind: 'personal',
    weight: 0.5,
    pattern: /\bdear (?:[A-Z][a-z]+|mr|mrs|ms|dr|prof)\b/,
    when: (ctx) => !looksLikeBulkSender(ctx.email.fromAddress),
  },
];

/** Characters of context kept on each side of a signal match. */
const EVIDENCE_WINDOW = 30;

/** Upper bound on the evidence string, since it is shown to the user. */
const EVIDENCE_MAX = 120;

/**
 * A window of text around the match, used to explain *why* a signal fired.
 *
 * Both edges are snapped to word boundaries. A fixed `30`-character window lands
 * mid-word for roughly three matches in four, so "firmation. Your email address
 * has been verified" and "your verification is comp" are what the raw window
 * produces. Both read as truncation damage even though the detection is correct,
 * and this text is shown to the user in the audit trail.
 */
function firstEvidence(text: string, pattern: RegExp): string {
  const m = pattern.exec(text);
  if (!m || m.index === undefined) return '';

  const windowStart = Math.max(0, m.index - EVIDENCE_WINDOW);
  const windowEnd = Math.min(text.length, m.index + m[0].length + EVIDENCE_WINDOW);

  const head = windowStart > 0 ? text.indexOf(' ', windowStart) : 0;
  const tail = windowEnd < text.length ? text.indexOf(' ', windowEnd) : text.length;

  return trimToWordBoundary(
    text.slice(head === -1 ? windowStart : head, tail === -1 ? windowEnd : tail),
    EVIDENCE_MAX,
  );
}

/**
 * Shortens text to `limit` at a word boundary, marking a cut with an ellipsis.
 *
 * A partial trailing word ("your verification is comp") reads as truncation
 * damage rather than as a quote that continues. Text that already fits is
 * returned unchanged, so short evidence is never mangled.
 */
export function trimToWordBoundary(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;

  const cut = flat.lastIndexOf(' ', limit);
  const body = (cut > 0 ? flat.slice(0, cut) : flat.slice(0, limit)).trimEnd();
  return `${body}…`;
}

function isNoiseLikeSender(ctx: Context): boolean {
  return looksLikeBulkSender(ctx.email.fromAddress);
}

/**
 * Extracts all signals present in an email. Pure, deterministic, and cheap.
 */
export function extractSignals(email: NormalizedEmail): Signal[] {
  const body = email.bodyText.replace(/\s+/g, ' ').trim();
  const ctx: Context = {
    text: signalText(email),
    subject: email.subject,
    body,
    email,
    wordCount: body.split(/\s+/).filter(Boolean).length,
  };

  const signals: Signal[] = [];
  for (const rule of RULES) {
    // A rule matches only when its pattern hits AND its `when` guard passes.
    // Getting this wrong in either direction is a real bug: ignoring the guard
    // marks "nothing is required" as an obligation, and ignoring the pattern
    // marks every bulk email as marketing regardless of its content.
    const patternHit = rule.pattern.test(ctx.text);
    const guardAllows = rule.when ? rule.when(ctx) : true;
    const hit = patternHit && guardAllows;
    if (!hit) continue;

    signals.push({
      kind: rule.kind,
      // `^$` is the marker for header-derived rules, which have no text match
      // to point at, so their evidence comes from the headers instead.
      evidence:
        rule.pattern.source === '^$' ? describeHeaderEvidence(rule.kind, email) : firstEvidence(ctx.text, rule.pattern),
      weight: rule.weight,
    });
  }

  // Question mark is only meaningful in the *authored* portion, and only if the
  // sender is plausibly a person asking the user something.
  if (QUESTION_RE.test(ctx.body) && ctx.wordCount > 12) {
    const qMatch = /[^.!?\n]{0,90}\?/.exec(ctx.body);
    signals.push({
      kind: 'question',
      evidence: (qMatch?.[0] ?? '').trim(),
      weight: isNoiseLikeSender(ctx) ? 0.3 : 0.7,
    });
  }

  // Very short bodies from human senders are usually short personal notes.
  if (ctx.wordCount > 0 && ctx.wordCount <= 40 && !isNoiseLikeSender(ctx)) {
    signals.push({ kind: 'personal', evidence: 'short message from a person', weight: 0.35 });
  }

  // A long, marketing-shaped body from a bulk sender is marketing regardless of
  // whether it happens to contain the word "unsubscribe".
  if (ctx.wordCount > 250 && isNoiseLikeSender(ctx)) {
    signals.push({ kind: 'marketing', evidence: 'long body from a bulk sender', weight: 0.5 });
  }

  return dedupeSignals(signals);
}

function describeHeaderEvidence(kind: SignalKind, email: NormalizedEmail): string {
  switch (kind) {
    case 'bulk':
      return [
        email.listUnsubscribe ? 'List-Unsubscribe header present' : '',
        email.listId ? `List-Id: ${email.listId}` : '',
        email.precedence ? `Precedence: ${email.precedence}` : '',
        email.gmailCategory ? `Gmail category: ${email.gmailCategory}` : '',
      ]
        .filter(Boolean)
        .join('; ');
    default:
      return '';
  }
}

function dedupeSignals(signals: Signal[]): Signal[] {
  const byKind = new Map<SignalKind, Signal>();
  for (const s of signals) {
    const existing = byKind.get(s.kind);
    if (!existing || s.weight > existing.weight) byKind.set(s.kind, s);
  }

  // A message that both reassures and demands must be read as the demand.
  const hasObligation = NOOP_DEFEATED_BY.some((k) => byKind.has(k));
  if (hasObligation) byKind.delete('automated_noop');

  return [...byKind.values()].sort((a, b) => b.weight - a.weight);
}

export function hasKind(signals: Signal[], kind: SignalKind): boolean {
  return signals.some((s) => s.kind === kind);
}

export function kindsOf(signals: Signal[]): SignalKind[] {
  return signals.map((s) => s.kind);
}

/** Evidence of a sender asking the user to do something. */
export function hasActionRequest(signals: Signal[]): boolean {
  return hasKind(signals, 'action_request') || hasKind(signals, 'obligation');
}
