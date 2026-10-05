// Test imports omit the `.js` extension that production source uses: Node's
// ESM resolver needs it, Vitest's Vite resolver does not. See vitest.config.ts.
import { describe, expect, it } from 'vitest';
import type { RawMessage } from '../src/mail/provider.js';
import {
  decodeMimeWords,
  htmlToText,
  parseAddressList,
  parseRawEmail,
  decodeQuotedPrintable,
} from '../src/mail/parser.js';
import {
  makeExcerpt,
  stripQuotedAndFooter,
  stripUrls,
  toNormalizedEmail,
} from '../src/mail/normalize.js';
import { trimToWordBoundary } from '../src/attention/signals.js';

function raw(headers: Record<string, string>, body: string): string {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `${head}\n\n${body}`;
}

describe('decodeMimeWords', () => {
  it('decodes base64 encoded subjects', () => {
    expect(decodeMimeWords('=?utf-8?B?RG9tYWluIHZlcmlmaWNhdGlvbg==?=')).toBe('Domain verification');
  });

  it('decodes quoted-printable encoded subjects', () => {
    expect(decodeMimeWords('=?utf-8?Q?Please=20confirm=20your=20booking?=')).toBe(
      'Please confirm your booking',
    );
  });

  it('joins adjacent encoded words without inserting whitespace', () => {
    // Per RFC 2047, whitespace between adjacent encoded words is not part of
    // the decoded text. A naive decoder yields "ab" and "cd" with a space.
    const encoded = '=?utf-8?B?YQ==?= =?utf-8?B?Yg==?=';
    expect(decodeMimeWords(encoded)).toBe('ab');
  });

  it('handles a charset declared after an asterisk (RFC 2231 style)', () => {
    expect(decodeMimeWords('=?utf-8*en?Q?Urgent=20matter?=')).toBe('Urgent matter');
  });

  it('returns an empty string for malformed input rather than throwing', () => {
    expect(() => decodeMimeWords('=?utf-8?B?!!!not-base64!!!?=')).not.toThrow();
    expect(decodeMimeWords('plain subject')).toBe('plain subject');
  });
});

describe('parseAddressList', () => {
  it('parses a name plus angle-bracket address', () => {
    const list = parseAddressList('Dr. Ada Mensah <a.mensah@university.example>');
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Dr. Ada Mensah');
    expect(list[0].address).toBe('a.mensah@university.example');
  });

  it('splits multiple addresses while respecting quotes and brackets', () => {
    const list = parseAddressList('"Mensah, Ada" <ada@x.example>, priya@y.example, <z@w.example>');
    expect(list.map((a) => a.address)).toEqual(['ada@x.example', 'priya@y.example', 'z@w.example']);
  });

  it('returns an empty list for empty input', () => {
    expect(parseAddressList('')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('converts block elements to line breaks', () => {
    expect(htmlToText('<p>First</p><p>Second</p>')).toBe('First\n\nSecond');
  });

  it('removes script and style elements including their contents', () => {
    const html = '<style>body{color:red}</style><p>Hello</p><script>alert(1)</script>';
    const out = htmlToText(html);
    expect(out).toBe('Hello');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('color');
  });

  it('decodes HTML entities', () => {
    expect(htmlToText('<p>R&amp;D &lt;team&gt; &#8364;50</p>')).toBe('R&D <team> \u20ac50');
  });

  it('keeps currency symbols intact so amount detection still works', () => {
    // Expanding "&euro;" to "EUR" would break the engine's /[$€£]\d/ amount
    // pattern, so the symbol must survive entity decoding.
    expect(htmlToText('<p>Total &pound;45 outstanding</p>')).toContain('\u00a345');
  });

  it('keeps link targets visible so calls to action are not content-free', () => {
    const out = htmlToText('<a href="https://example.com/verify">Verify now</a>');
    expect(out).toContain('Verify now');
    expect(out).toContain('https://example.com/verify');
  });

  it('strips image tags and other markup entirely', () => {
    const out = htmlToText('<img src="https://tracker.example/pixel.gif" onerror="steal()"><p>Text</p>');
    expect(out).toBe('Text');
    expect(out).not.toContain('tracker.example');
    expect(out).not.toContain('onerror');
  });

  it('handles closed script tags', () => {
    expect(htmlToText('<script src="x.js"></script><p>Safe</p>')).toBe('Safe');
  });

  it('neutralises an unterminated script tag by discarding its contents', () => {
    // An unclosed <script> means every following byte is, per the HTML spec,
    // script source. Nothing after it may reach the output.
    const out = htmlToText('<p>A</p><script>bad()');
    expect(out).toBe('A');
    expect(out).not.toContain('bad()');
  });

  it('does not execute or evaluate anything it encounters', () => {
    // A structural assertion: the converter is string processing only, so the
    // output must contain the literal text and none of the executable context.
    const out = htmlToText('<div>${require("fs")}</div><p>{{constructor}}</p>');
    expect(out).toContain('require("fs")');
    expect(out).toContain('{{constructor}}');
    expect(out).not.toContain('<div>');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('decodeQuotedPrintable', () => {
  it('decodes soft line breaks and hex escapes', () => {
    expect(decodeQuotedPrintable('Hello=20World=\r\nand=20more')).toBe('Hello Worldand more');
  });

  it('decodes UTF-8 byte sequences', () => {
    expect(decodeQuotedPrintable('caf=C3=A9')).toBe('café');
  });
});

describe('parseRawEmail', () => {
  it('parses a simple plain-text message', () => {
    const parsed = parseRawEmail(
      raw(
        {
          From: 'Priya Raman <priya@partner.example>',
          To: 'demo@local.test',
          Subject: 'Question about the plan',
          Date: 'Sat, 26 Sep 2026 10:00:00 +0000',
        },
        'Hi,\n\nCan you take a look?\n',
      ),
    );

    expect(parsed.subject).toBe('Question about the plan');
    expect(parsed.from.name).toBe('Priya Raman');
    expect(parsed.from.address).toBe('priya@partner.example');
    expect(parsed.to).toEqual(['demo@local.test']);
    expect(parsed.textBody).toContain('Can you take a look?');
    expect(parsed.date?.toISOString()).toBe('2026-09-26T10:00:00.000Z');
  });

  it('prefers the plain-text part over HTML when both exist', () => {
    const boundary = 'PART_BOUNDARY_1';
    const message = [
      'From: a@x.example',
      'To: demo@local.test',
      'Subject: Both parts',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Plain version here.',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<p>HTML version here.</p>',
      `--${boundary}--`,
    ].join('\r\n');

    const parsed = parseRawEmail(message);
    expect(parsed.textBody).toContain('Plain version here.');
    expect(parsed.textBody).not.toContain('HTML version here.');
    expect(parsed.htmlBody).toContain('HTML version here.');
  });

  it('falls back to converted HTML when there is no plain-text part', () => {
    const message = [
      'From: a@x.example',
      'To: demo@local.test',
      'Subject: HTML only',
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<html><body><p>Only HTML</p></body></html>',
    ].join('\r\n');

    const parsed = parseRawEmail(message);
    expect(parsed.textBody).toContain('Only HTML');
    expect(parsed.textBody).not.toContain('<p>');
  });

  it('decodes base64 bodies', () => {
    const encoded = Buffer.from('Hello from base64', 'utf8').toString('base64');
    const message = [
      'From: a@x.example',
      'To: demo@local.test',
      'Subject: Base64',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encoded,
    ].join('\r\n');

    expect(parseRawEmail(message).textBody).toContain('Hello from base64');
  });

  it('does not throw on malformed input', () => {
    expect(() => parseRawEmail('this is not an email')).not.toThrow();
    expect(() => parseRawEmail('')).not.toThrow();
    const parsed = parseRawEmail('garbage without headers');
    expect(parsed.subject).toBe('');
    expect(parsed.from.address).toBe('');
  });
});

describe('stripQuotedAndFooter', () => {
  it('removes a quoted reply chain', () => {
    const body = [
      'Here is my answer.',
      '',
      'On Tue, 22 Sep 2026 at 11:00, Support wrote:',
      '> Please verify your account',
      '> urgently',
    ].join('\n');

    const out = stripQuotedAndFooter(body);
    expect(out).toContain('Here is my answer.');
    expect(out).not.toContain('Please verify your account');
  });

  it('removes a signature delimited by --', () => {
    const body = 'The report is attached.\n\n--\nSent from my phone\nExample Ltd';
    const out = stripQuotedAndFooter(body);
    expect(out).toBe('The report is attached.');
  });

  it('removes an unsubscribe footer', () => {
    const body = 'Our new product launches today.\n\nUnsubscribe from this email\nManage preferences';
    const out = stripQuotedAndFooter(body);
    expect(out).toBe('Our new product launches today.');
  });
});

describe('trimToWordBoundary', () => {
  it('leaves text that fits unchanged', () => {
    expect(trimToWordBoundary('short text', 120)).toBe('short text');
    expect(trimToWordBoundary('exactly ten', 11)).toBe('exactly ten');
  });

  it('never ends mid-word', () => {
    // A cut like "your verification is comp" reads as truncation damage rather
    // than as a quote that continues.
    const out = trimToWordBoundary('your email address has been verified', 20);
    expect(out).toBe('your email address…');
    expect(out).not.toContain(' has');
  });

  it('keeps a whole word that ends exactly on the limit', () => {
    const out = trimToWordBoundary('your email address has been verified', 22);
    expect(out).toBe('your email address has…');
  });

  it('marks a cut with an ellipsis', () => {
    const out = trimToWordBoundary('one two three four five six seven', 12);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(13);
  });

  it('does not add an ellipsis when nothing was cut', () => {
    expect(trimToWordBoundary('short', 120)).toBe('short');
    expect(trimToWordBoundary('short', 120)).not.toContain('…');
  });

  it('collapses whitespace', () => {
    expect(trimToWordBoundary('a  \n b', 120)).toBe('a b');
  });

  it('is idempotent', () => {
    const once = trimToWordBoundary('alpha beta gamma delta epsilon', 20);
    expect(trimToWordBoundary(once, 20)).toBe(once);
  });
});

describe('stripUrls', () => {
  it('removes URLs but leaves surrounding words intact', () => {
    expect(stripUrls('Visit https://example.com/x now please')).toBe('Visit now please');
  });
});

describe('makeExcerpt', () => {
  it('returns short text unchanged', () => {
    expect(makeExcerpt('Short text', 100)).toBe('Short text');
  });

  it('truncates at a sentence boundary when one is available', () => {
    const text = `${'word '.repeat(40)}This is the end. And more words follow here to exceed the limit.`;
    const excerpt = makeExcerpt(text, 200);
    expect(excerpt.length).toBeLessThanOrEqual(203);
    expect(excerpt.endsWith('...') || excerpt.endsWith('.')).toBe(true);
  });

  it('never exceeds the limit by more than the ellipsis', () => {
    const text = 'a'.repeat(1000);
    expect(makeExcerpt(text, 50).length).toBeLessThanOrEqual(53);
  });
});

describe('toNormalizedEmail', () => {
  it('normalizes a Gmail message payload', () => {
    const normalized = toNormalizedEmail({
      id: 'm1',
      threadId: 't1',
      internalDateMs: Date.parse('2026-09-28T09:05:00.000Z'),
      snippet: 'Action required',
      labelIds: ['INBOX', 'IMPORTANT'],
      raw: raw(
        {
          From: 'Registrar Compliance <compliance@registrar.example>',
          To: 'demo@local.test',
          Subject: 'Action required: verify registrant contact',
          'List-Unsubscribe': '<mailto:u@registrar.example>',
        },
        'Please complete identity verification within 72 hours.',
      ),
    });

    expect(normalized.id).toBe('m1');
    expect(normalized.threadId).toBe('t1');
    expect(normalized.fromAddress).toBe('compliance@registrar.example');
    expect(normalized.fromDomain).toBe('registrar.example');
    expect(normalized.listUnsubscribe).toBe(true);
    expect(normalized.labels).toContain('IMPORTANT');
    expect(normalized.bodyText).toContain('Please complete identity verification');
  });

  it('produces a usable object even with no raw message', () => {
    const normalized = toNormalizedEmail({
      id: 'm2',
      threadId: 't2',
      internalDateMs: null,
      snippet: 'Just a snippet',
      labelIds: [],
      raw: null,
    });

    expect(normalized.subject).toBe('');
    expect(normalized.bodyText).toBe('');
    expect(normalized.snippet).toBe('Just a snippet');
    expect(Number.isNaN(normalized.date.getTime())).toBe(false);
  });
});

describe('RawMessage typing', () => {
  it('accepts a fully populated message', () => {
    const message: RawMessage = {
      id: 'x',
      threadId: 'y',
      internalDateMs: Date.now(),
      snippet: 's',
      labelIds: ['INBOX'],
      raw: 'From: a@b.c',
    };
    expect(message.threadId).toBe('y');
  });
});
