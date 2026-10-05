import {
  extractDomain,
  getAllHeaders,
  getHeader,
  parseRawEmail,
  type ParsedEmail,
} from './parser.js';
import type { NormalizedEmail } from '../domain/types.js';

/** Google labels that reliably indicate bulk / machine mail. */
const BULK_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']);

const TRACKING_SENDER_MARKERS = [
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'notifications@',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'mail-daemon',
  'updates@',
  'news@',
  'newsletter@',
  'marketing@',
  'promo@',
];

const SIGNATURE_TAIL_MARKERS = [
  /^--\s*$/m,
  /^sent from my \w+/im,
  /^get outlook for /im,
  /^view in browser\s*$/im,
  /^you'?re receiving this email because/im,
  /^this email was sent to /im,
  /^unsubscribe\s*(here|link|:)?/im,
];

const QUOTE_MARKERS = [
  /^-{2,}\s*original message\s*-{2,}/im,
  // Markdown turns "> On Tue, ... wrote:" into "> > > On ..." when quoted
  // repeatedly, so allow one or more carets rather than a literal three-or-more
  // quantifier, which is not valid on its own.
  /^(?:\s*>\s*)+.{0,120}\b(?:on|wrote)\b.{0,80}:/im,
  /^\s*>\s?/m,
  /^at .+ wrote:$/im,
];

/**
 * Strips quoted replies, signatures, and unsubscribe footers from a body.
 * This matters for signal detection: a "?" or a "please" inside a forwarded
 * chain is not a request to the user.
 */
export function stripQuotedAndFooter(text: string): string {
  let out = text;

  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(out);
    if (m && m.index > 0) out = out.slice(0, m.index);
  }

  // Footer blocks: everything after an unsubscribe / view-in-browser line.
  const footerMatch = /(?:unsubscribe|view (?:this email )?in (?:your )?browser|manage preferences|preferences center)/i.exec(
    out,
  );
  if (footerMatch && footerMatch.index > 0) {
    out = out.slice(0, footerMatch.index);
  }

  // Signature delimiter.
  const sigMatch = /^--\s*$/m.exec(out);
  if (sigMatch && sigMatch.index > 0) out = out.slice(0, sigMatch.index);

  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Removes bare URLs and tracking pixels from display text. */
export function stripUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Heuristic truncation at a sentence boundary where possible, so an excerpt
 * shown in the UI ends as readable text rather than mid-word.
 */
export function makeExcerpt(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;

  const window = clean.slice(0, maxChars);
  const lastStop = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('; '),
  );
  if (lastStop > maxChars * 0.5) return `${window.slice(0, lastStop + 1).trim()}`;
  const lastSpace = window.lastIndexOf(' ');
  return `${window.slice(0, lastSpace > 0 ? lastSpace : maxChars).trim()}...`;
}

export function looksLikeBulkSender(fromAddress: string): boolean {
  const lower = fromAddress.toLowerCase();
  return TRACKING_SENDER_MARKERS.some((m) => lower.includes(m));
}

export function hasSignatureTail(text: string): boolean {
  return SIGNATURE_TAIL_MARKERS.some((m) => m.test(text));
}

/**
 * Converts a raw Gmail message into the engine's `NormalizedEmail`.
 *
 * Gmail gives us two representations: metadata (snippet, labels, internalDate)
 * and the full RFC822 source. We prefer metadata for fields Gmail is
 * authoritative about, and fall back to the parsed source. Everything is
 * tolerant of missing fields.
 */
export function toNormalizedEmail(input: {
  id: string;
  threadId: string;
  internalDateMs: number | null;
  snippet: string | null;
  labelIds: string[];
  raw: string | null;
}): NormalizedEmail {
  const parsed: ParsedEmail | null = input.raw ? parseRawEmail(input.raw) : null;
  const headers = parsed?.headers ?? [];

  const subject = (parsed?.subject ?? '').trim();
  const fromRaw = parsed?.from.address ?? '';
  const fromAddress = fromRaw.toLowerCase();

  const internalDate =
    input.internalDateMs && input.internalDateMs > 0
      ? new Date(input.internalDateMs)
      : parsed?.date ?? new Date(0);
  const date = Number.isNaN(internalDate.getTime()) ? new Date(0) : internalDate;

  const fullBody = parsed?.textBody ?? '';
  const bodyClean = stripQuotedAndFooter(fullBody);
  const bodyForSignals = stripUrls(bodyClean);

  const labels = input.labelIds ?? [];
  const listUnsubscribe = getHeader(headers, 'list-unsubscribe') !== null;
  const listId = getHeader(headers, 'list-id');
  const precedence = getHeader(headers, 'precedence');

  const gmailCategory = labels.find((l) => l.startsWith('CATEGORY_')) ?? null;

  return {
    id: input.id,
    threadId: input.threadId,
    subject,
    fromName: parsed?.from.name ?? null,
    fromAddress,
    fromDomain: extractDomain(fromAddress),
    to: parsed?.to ?? [],
    cc: parsed?.cc ?? [],
    snippet: (input.snippet ?? '').replace(/\s+/g, ' ').trim(),
    bodyText: bodyClean,
    bodyWasHtml: parsed !== null && parsed.textBody.trim().length === 0 && parsed.htmlBody.length > 0,
    date,
    labels,
    gmailCategory,
    listUnsubscribe,
    listId: listId ?? null,
    precedence: precedence?.toLowerCase() ?? null,
    messageIdHeader: getHeader(headers, 'message-id'),
    inReplyTo: getHeader(headers, 'in-reply-to'),
    references: getAllHeaders(headers, 'references')
      .flatMap((r) => r.split(/\s+/))
      .filter((r) => r.length > 0),
  };
}

export { BULK_LABELS };

/** Signal-friendly text: subject + cleaned body, truncated for cost control. */
export function signalText(email: NormalizedEmail, maxChars = 4000): string {
  const combined = `${email.subject}\n\n${stripUrls(email.bodyText)}`;
  return combined.length > maxChars ? combined.slice(0, maxChars) : combined;
}
