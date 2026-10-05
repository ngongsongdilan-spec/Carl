/**
 * Date tokens in fixture text.
 *
 * Fixtures cannot simply hard-code dates like "due 10 September": that keeps the
 * tests deterministic but makes the demo rot. As soon as real time passes the
 * deadline, the engine correctly suppresses the item as expired and the demo
 * silently shows nothing.
 *
 * So dates in fixture bodies are written as offsets from that fixture's anchor
 * date (`due {{+9d}}`), and expanded here:
 *
 *   - in tests, against the fixture's original anchor, so the pinned dates and
 *     the assertions that depend on them are unchanged
 *   - in the demo, against a shifted anchor, so every deadline stays live
 */

const TOKEN = /\{\{\s*([+-])(\d+)([dhm])\s*\}\}/g;

const UNIT_MS: Record<string, number> = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
};

/** Renders a Date as `12 October 2026`. */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Renders a Date as `14 October` (no year), for "due on ..." phrasing. */
export function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/** Renders a Date as `10 September 2026 at 14:15`. */
export function formatDateTime(date: Date): string {
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${formatLongDate(date)} at ${time}`;
}

/** The Date headers a fixture uses, e.g. `Mon, 28 Sep 2026 09:05:00 +0000`. */
export function formatRfcDate(date: Date): string {
  return date.toUTCString().replace('GMT', '+0000');
}

export interface ExpandOptions {
  /** The date `+0d` refers to. */
  anchor: Date;
  /** Overrides for the two supported renderings. */
  long?: (d: Date) => string;
  short?: (d: Date) => string;
}

/**
 * Replaces every `{{±N<unit>}}` token with a formatted date derived from the
 * anchor. Unknown tokens are left untouched so a typo is visible rather than
 * silently blank.
 */
export function expandDateTokens(text: string, options: ExpandOptions): string {
  const long = options.long ?? formatLongDate;
  const short = options.short ?? formatShortDate;

  return text.replace(TOKEN, (match, sign: string, digits: string, unit: string) => {
    const ms = UNIT_MS[unit];
    if (ms === undefined) return match;
    const offset = (sign === '-' ? -1 : 1) * Number(digits) * ms;
    const resolved = new Date(options.anchor.getTime() + offset);
    // Long form by default; a token inside a short phrase is handled by the
    // caller choosing `short` for that fixture.
    return long(resolved);
  });
}
