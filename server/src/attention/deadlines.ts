import type { DeadlineDraft } from '../domain/types.js';

/**
 * Deadline extraction.
 *
 * Explicit dates are matched in several formats and resolved against the
 * message's own timestamp so that "due in 3 days" and "due 3 October" both
 * produce a concrete ISO date. Relative phrases without a resolvable anchor
 * (bare "soon", "shortly") deliberately return `iso: null` -- the product spec
 * requires the UI to be able to say "no deadline detected" honestly rather than
 * invent a date.
 */

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function atEndOfDay(base: Date): Date {
  const d = new Date(base);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfDay(base: Date): Date {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** "in 3 days", "within 48 hours", "in two weeks" */
const RELATIVE_DAYS =
  /\b(?:within|in|after|for the next)\s+(\d{1,3})\s*(business\s+)?(day|hour|week|month|year)s?\b/gi;
const RELATIVE_NAMED =
  /\b(?:within|in)\s+(a\s+couple\s+of|two|three|four|five|seven|fourteen|\d+)\s+(business\s+)?(days?|weeks?|months?|hours?)\b/gi;

/** "by Friday", "before Monday", "on 15 March", "due 3/10" */
const BY_WEEKDAY =
  /\b(?:by|before|on|due\s+(?:by|on)?|no later than|until)\s+(this\s+|next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const ABSOLUTE_DMY = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/i;
const ABSOLUTE_MDY =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i;
const NUMERIC_SLASH = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const YEAR_PLAIN = /\b(20\d{2})\b/;

const DEADLINE_CONTEXT =
  /\b(?:due|deadline|expires?|expiring|expires on|valid (?:until|through)|submit by|respond by|reply by|register by|pay by|complete by|return by|confirm by|no later than|before|by the end of|within|in \d+ (?:days?|hours?)|expires? in)\b/i;

/** Phrases that look like deadlines but carry no resolvable date. */
const VAGUE = /\b(?:as soon as (?:possible|you can)|shortly|soon|right away|in a timely manner|at your earliest convenience|promptly|immediately)\b/i;

function monthIndex(token: string): number {
  return MONTHS[token.toLowerCase().replace(/\.$/, '')] ?? -1;
}

function toIso(d: Date): string {
  return d.toISOString();
}

export interface DeadlineExtraction {
  deadline: DeadlineDraft;
  /** True when deadline-shaped language exists but no concrete date was found. */
  vagueDeadlineLanguage: boolean;
}

export function emptyDeadlineDraft(): DeadlineDraft {
  return { iso: null, raw: null, kind: 'explicit', confidence: 0 };
}

/**
 * Scans text for a deadline, resolving relative expressions against `anchor`
 * (the message timestamp).
 */
export function extractDeadline(text: string, anchor: Date): DeadlineExtraction {
  const haystack = text.replace(/\s+/g, ' ');
  const hasContext = DEADLINE_CONTEXT.test(haystack) || EXPIRY_CONTEXT.test(haystack);
  const vague = VAGUE.test(haystack);

  // 0. Unambiguous relative durations first.
  //
  // "You must reset your password within 24 hours" contains both a duration and
  // an unrelated absolute date ("When: 28 September 2026 at 22:38"), and the
  // duration is the real deadline. Scanning absolute dates first would pick up
  // the event timestamp, which has already passed by the time you read it.
  const rel = /\bwithin\s+(\d{1,3})\s*(business\s+)?(day|hour|week|month|year)s?\b/i.exec(haystack);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[3].toLowerCase();
    let d: Date;
    if (rel[2]) d = addBusinessDays(anchor, n);
    else if (unit === 'hour') d = new Date(anchor.getTime() + n * 3_600_000);
    else if (unit === 'week') d = addDays(anchor, n * 7);
    else if (unit === 'month') d = addDays(anchor, n * 30);
    else if (unit === 'year') d = addDays(anchor, n * 365);
    else d = addDays(anchor, n);
    return {
      deadline: { iso: toIso(d), raw: rel[0], kind: 'relative', confidence: 0.75 },
      vagueDeadlineLanguage: vague,
    };
  }

  const expiryDur = /\bexpires?\s+in\s+(\d{1,3})\s*(day|week|month)s?\b/i.exec(haystack);
  if (expiryDur) {
    const n = Number(expiryDur[1]);
    const mult =
      expiryDur[2].toLowerCase() === 'week' ? 7 : expiryDur[2].toLowerCase() === 'month' ? 30 : 1;
    return {
      deadline: {
        iso: toIso(addDays(anchor, n * mult)),
        raw: expiryDur[0],
        kind: 'expiry',
        confidence: 0.8,
      },
      vagueDeadlineLanguage: vague,
    };
  }

  // 1. Absolute ISO-ish dates, most trustworthy.
  const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(haystack);
  if (isoMatch && hasContext) {
    // Built in UTC so the extracted date does not shift with the machine's
    // timezone, then extended to the end of that day in local time.
    const utc = new Date(
      Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])),
    );
    if (!Number.isNaN(utc.getTime())) {
      const local = new Date(
        utc.getUTCFullYear(),
        utc.getUTCMonth(),
        utc.getUTCDate(),
        23,
        59,
        59,
        999,
      );
      return {
        deadline: { iso: toIso(local), raw: isoMatch[0], kind: 'explicit', confidence: 0.85 },
        vagueDeadlineLanguage: vague,
      };
    }
  }

  // 2. "15 March 2026" / "March 15, 2026"
  // Only with deadline context: a bare date is far more often an event timestamp
  // or a record date than a deadline.
  const mdy = hasContext ? ABSOLUTE_MDY.exec(haystack) : null;
  if (mdy) {
    const mi = monthIndex(mdy[1]);
    if (mi !== -1) {
      const day = Number(mdy[2]);
      const year = mdy[3] ? Number(mdy[3]) : anchor.getFullYear();
      const d = new Date(year, mi, day, 23, 59, 59, 999);
      if (!Number.isNaN(d.getTime()) && day <= 31) {
        const raw = mdy[0];
        return {
          deadline: {
            iso: toIso(resolveYear(d, anchor)),
            raw,
            kind: 'explicit',
            confidence: hasContext ? 0.85 : 0.6,
          },
          vagueDeadlineLanguage: vague,
        };
      }
    }
  }

  // 3. "3 October" / "October 3rd"
  const dmy = hasContext ? ABSOLUTE_DMY.exec(haystack) : null;
  if (dmy) {
    const mi = monthIndex(dmy[2]);
    if (mi !== -1) {
      const day = Number(dmy[1]);
      const year = dmy[3] ? Number(dmy[3]) : anchor.getFullYear();
      const d = new Date(year, mi, day, 23, 59, 59, 999);
      if (!Number.isNaN(d.getTime()) && day <= 31) {
        return {
          deadline: {
            iso: toIso(resolveYear(d, anchor)),
            raw: dmy[0],
            kind: 'explicit',
            confidence: hasContext ? 0.85 : 0.6,
          },
          vagueDeadlineLanguage: vague,
        };
      }
    }
  }

  // 4. Weekday deadlines -- "by Friday".
  const wd = BY_WEEKDAY.exec(haystack);
  if (wd) {
    const target = weekdayIndex(wd[2]);
    if (target !== -1) {
      const qualifier = (wd[1] ?? '').toLowerCase();
      const d = nextWeekday(anchor, target, qualifier);
      return {
        deadline: { iso: toIso(atEndOfDay(d)), raw: wd[0], kind: 'relative', confidence: 0.7 },
        vagueDeadlineLanguage: vague,
      };
    }
  }

  // 5. Numeric date with slashes. Ambiguous d/m vs m/d; treated as d/m only when
  //    the first component cannot be a month, and flagged with lower confidence.
  const slash = NUMERIC_SLASH.exec(haystack);
  if (slash && (hasContext || /\b(?:on|due|by)\b/.test(haystack))) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = slash[3] ? normalizeYear(Number(slash[3])) : anchor.getFullYear();
    if (b <= 12 && a <= 31 && a >= 1) {
      const d = new Date(year, b - 1, a, 23, 59, 59, 999);
      if (!Number.isNaN(d.getTime())) {
        return {
          deadline: {
            iso: toIso(resolveYear(d, anchor)),
            raw: slash[0],
            kind: 'explicit',
            confidence: b <= 12 ? 0.55 : 0.7,
          },
          vagueDeadlineLanguage: vague,
        };
      }
    }
  }

  // 6. "in two weeks" -- named numbers.
  const named = RELATIVE_NAMED.exec(haystack);
  if (named) {
    const n = NUMBER_WORDS[named[1].toLowerCase().replace(/\s+/g, ' ')] ?? 2;
    const unit = (named[3] ?? 'days').toLowerCase();
    const mult = unit.startsWith('week')
      ? 7
      : unit.startsWith('month')
        ? 30
        : unit.startsWith('hour')
          ? 0.04
          : 1;
    const d = addDays(anchor, Math.round(n * mult));
    return {
      deadline: { iso: toIso(d), raw: named[0], kind: 'relative', confidence: 0.65 },
      vagueDeadlineLanguage: vague,
    };
  }

  // 7. "this year only" style -- a year mention with expiry context.
  const yearOnly = YEAR_PLAIN.exec(haystack);
  if (yearOnly && EXPIRY_CONTEXT.test(haystack)) {
    const d = new Date(Number(yearOnly[1]), 11, 31, 23, 59, 59, 999);
    return {
      deadline: { iso: toIso(d), raw: yearOnly[0], kind: 'expiry', confidence: 0.5 },
      vagueDeadlineLanguage: vague,
    };
  }

  return { deadline: emptyDeadlineDraft(), vagueDeadlineLanguage: vague };
}

const EXPIRY_CONTEXT =
  /\b(?:expire[sd]?|expiring|valid (?:until|through|for)|renewal (?:date|window|due)|no longer valid|lapses?|runs? out)\b/i;

const NUMBER_WORDS: Record<string, number> = {
  'a couple of': 2,
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fourteen: 14,
};

function normalizeYear(y: number): number {
  if (y < 100) return 2000 + y;
  return y;
}

/** Rolls a date into the future when only a weekday was given. */
function resolveYear(d: Date, anchor: Date): Date {
  const candidate = new Date(d);
  if (candidate.getTime() < startOfDay(anchor).getTime() - 30 * DAY_MS) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }
  return candidate;
}

function weekdayIndex(name: string): number {
  const map: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  return map[name.toLowerCase()] ?? -1;
}

function nextWeekday(anchor: Date, target: number, qualifier: string): Date {
  const d = startOfDay(anchor);
  if (qualifier.includes('next')) {
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta + 7);
    return d;
  }
  let delta = (target - d.getDay() + 7) % 7;
  if (delta === 0 && !qualifier.includes('this')) delta = 7;
  d.setDate(d.getDate() + delta);
  return d;
}

function addBusinessDays(anchor: Date, n: number): Date {
  const d = new Date(anchor);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

/** True when a deadline has already elapsed, so the item is no longer live. */
export function isDeadlinePassed(iso: string, now: Date): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t < now.getTime();
}

/** Days remaining; negative when overdue. */
export function daysUntil(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now.getTime()) / DAY_MS);
}

export function formatDeadlineForDisplay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
