/**
 * RFC 2047 / MIME parsing plus a strict HTML -> text converter.
 *
 * Deliberately hand-rolled and offline:
 *   - no dependency that fetches remote content
 *   - no `innerHTML`, no DOM, no image loading
 *   - output is plain text that the frontend can render as text content only
 */

export interface ParsedHeader {
  name: string;
  value: string;
}

export interface MimePart {
  contentType: string;
  charset: string;
  disposition: string | null;
  contentId: string | null;
  transferEncoding: string;
  body: string;
  filename: string | null;
  headers: ParsedHeader[];
}

export interface ParsedEmail {
  headers: ParsedHeader[];
  subject: string;
  from: { name: string | null; address: string };
  to: string[];
  cc: string[];
  date: Date | null;
  textBody: string;
  htmlBody: string;
  parts: MimePart[];
}

const CHARSET_ALIASES: Record<string, string> = {
  'utf-8': 'utf-8',
  'utf8': 'utf-8',
  'us-ascii': 'utf-8',
  'ascii': 'utf-8',
  'iso-8859-1': 'latin1',
  'latin1': 'latin1',
  'iso-8859-15': 'latin1',
  'windows-1252': 'latin1',
  'windows-1251': 'latin1',
  'cp1252': 'latin1',
};

export function normalizeCharset(charset: string | undefined): string {
  if (!charset) return 'utf-8';
  return CHARSET_ALIASES[charset.trim().toLowerCase()] ?? 'utf-8';
}

/** Decodes a base64url/base64 string to a Buffer. Returns null on malformed input. */
export function decodeBase64(input: string): Buffer | null {
  const cleaned = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (cleaned.length === 0) return null;
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  try {
    const buf = Buffer.from(padded, 'base64');
    if (buf.length === 0 && padded.replace(/=/g, '').length > 0) return null;
    return buf;
  } catch {
    return null;
  }
}

function decodeTextBuffer(buf: Buffer, charset: string): string {
  const cs = normalizeCharset(charset);
  try {
    if (cs === 'utf-8') {
      // Strip an invalid leading BOM remnant and invalid sequences gracefully.
      return buf.toString('utf8').replace(/^\uFEFF/, '');
    }
    return new TextDecoder('iso-8859-1').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * RFC 2047 encoded-word decoding: `=?utf-8?B?...?=` / `=?utf-8?Q?...?=`
 * Also folds adjacent encoded words separated by whitespace, per the RFC.
 */
export function decodeMimeWords(input: string): string {
  if (!input) return '';
  const WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

  // RFC 2047 §6.2: whitespace between two adjacent encoded words is not part of
  // the decoded text. Collapsed first, before any decoding, so the removal is
  // based on the encoded form rather than on whatever it decodes to.
  const joined = input.replace(/\?=\s+(?==\?)/g, '?=');

  const out = joined.replace(WORD, (_full, charsetRaw: string, encoding: string, payload: string) => {
    const charset = normalizeCharset(charsetRaw.split('*')[0]);
    let bytes: Buffer;
    if (encoding.toUpperCase() === 'B') {
      const decoded = decodeBase64(payload);
      if (!decoded) return '';
      bytes = decoded;
    } else {
      const q = payload.replace(/_/g, ' ');
      const binary = q.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
      bytes = Buffer.from(binary, 'binary');
    }
    return decodeTextBuffer(bytes, charset);
  });

  return out;
}

function splitHeaderBlocks(raw: string): string[] {
  return raw.split(/\r?\n\r?\n/);
}

function unfoldHeaderLines(block: string): string[] {
  return block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).filter((l) => l.trim().length > 0);
}

export function parseHeaders(block: string): ParsedHeader[] {
  const headers: ParsedHeader[] = [];
  for (const line of unfoldHeaderLines(block)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers.push({
      name: line.slice(0, idx).trim(),
      value: line.slice(idx + 1).trim(),
    });
  }
  return headers;
}

export function getHeader(headers: ParsedHeader[], name: string): string | null {
  const lower = name.toLowerCase();
  const found = headers.find((h) => h.name.toLowerCase() === lower);
  return found ? found.value : null;
}

export function getAllHeaders(headers: ParsedHeader[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value);
}

export interface Address {
  name: string | null;
  address: string;
}

export function parseAddressList(raw: string): Address[] {
  const decoded = decodeMimeWords(raw ?? '');
  const out: Address[] = [];
  // Split on commas that are not inside quotes or angle brackets.
  let depth = 0;
  let inQuotes = false;
  let current = '';
  const chunks: string[] = [];
  for (const ch of decoded) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0 && !inQuotes) {
      chunks.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) chunks.push(current);

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const angle = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
    if (angle) {
      const addr = angle[2].trim();
      if (!addr) continue;
      const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim();
      out.push({ name: name || null, address: addr });
    } else if (trimmed.includes('@')) {
      out.push({ name: null, address: trimmed });
    }
  }
  return out;
}

export function extractDomain(address: string): string {
  const at = address.lastIndexOf('@');
  if (at === -1) return '';
  return address.slice(at + 1).toLowerCase().trim();
}

export function parseDateHeader(raw: string | null): Date | null {
  if (!raw) return null;
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;
  const unixSeconds = Number.parseInt(raw, 10);
  if (Number.isFinite(unixSeconds) && unixSeconds > 0) {
    const d = new Date(unixSeconds * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

export function parseContentType(value: string): {
  contentType: string;
  charset: string;
  disposition: string | null;
  boundary: string | null;
} {
  const segments = (value ?? '').split(';');
  const rawType = (segments[0] ?? '').trim().toLowerCase();
  let charset = 'utf-8';
  let disposition: string | null = null;
  let boundary: string | null = null;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i].trim();
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (key === 'charset') charset = val;
    else if (key === 'content-disposition') disposition = val.toLowerCase();
    else if (key === 'boundary') boundary = val;
  }
  return { contentType: rawType || 'text/plain', charset, disposition, boundary };
}

/**
 * Splits a multipart body into its parts.
 *
 * Delimiters must start a line, per RFC 2046 §5.1.1, so the split is done with
 * a multiline regex rather than a plain substring search -- otherwise a body
 * containing the boundary text mid-line would be split incorrectly. The
 * terminating delimiter is `--boundary--`.
 */
export function splitMultipart(raw: string, boundary: string): string[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');

  const boundaries: { start: number; end: number; isClose: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = delimiter.exec(raw)) !== null) {
    boundaries.push({ start: m.index, end: m.index + m[0].length, isClose: m[1] === '--' });
    if (m.index === delimiter.lastIndex) delimiter.lastIndex++;
  }

  if (boundaries.length < 2) return [];

  const parts: string[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const current = boundaries[i];
    if (current.isClose) break;
    const next = boundaries[i + 1];
    parts.push(raw.slice(current.end, next.start));
  }
  return parts;
}

function walkMime(raw: string, headers: ParsedHeader[], depth: number, out: MimePart[]): void {
  if (depth > 6) return; // zip-bomb / pathological nesting guard
  const { contentType, charset, disposition, boundary } = parseContentType(
    getHeader(headers, 'content-type') ?? 'text/plain',
  );

  if (contentType.startsWith('multipart/') && boundary) {
    for (const segment of splitMultipart(raw, boundary)) {
      // The closing delimiter "--boundary--" yields an empty segment; the
      // preamble before the first delimiter yields an empty one too. Both are
      // discarded by the emptiness check below.
      const blocks = splitHeaderBlocks(segment);
      if (blocks.length === 0) continue;
      const subHeaders = parseHeaders(blocks[0]);
      // A part with headers but no body is legal (it is just empty).
      const subBody = blocks.slice(1).join('\n\n');
      walkMime(subBody, subHeaders, depth + 1, out);
    }
    return;
  }

  out.push({
    contentType,
    charset,
    disposition,
    contentId: getHeader(headers, 'content-id'),
    transferEncoding: (getHeader(headers, 'content-transfer-encoding') ?? '7bit').toLowerCase(),
    body: raw,
    filename: parseFilename(getHeader(headers, 'content-disposition')),
    headers,
  });
}

function parseFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  const m = disposition.match(/filename\*?=(?:UTF-8'')?([^;]+)/i);
  if (!m) return null;
  const raw = m[1].trim().replace(/^"(.*)"$/, '$1');
  return decodeMimeWords(raw);
}

/**
 * HTML -> plain text.
 *
 * Uses an allowlist of block-level tags that imply a line break, drops every
 * other tag, and decodes entities. There is no code path that can execute or
 * fetch anything: this is string processing, not DOM construction.
 */
export function htmlToText(html: string): string {
  if (!html) return '';

  let text = html;

  // Remove entire dangerous/irrelevant elements including their content.
  text = text.replace(
    /<(script|style|head|title|noscript|template|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );

  // An unterminated raw-text element means everything after it is script source
  // per the HTML spec, so it is discarded rather than partially stripped.
  const unterminated = /<(script|style|iframe|object|embed)\b[^>]*>(?![\s\S]*<\/\1\s*>)/i.exec(text);
  if (unterminated) text = text.slice(0, unterminated.index);

  // Self-closing variants (e.g. <script src="x"/>).
  text = text.replace(/<(script|style|head|iframe|object|embed)\b[^>]*\/>/gi, ' ');

  // Preserve link targets inline so a bodyless "Open the document" link is still
  // content-free-free. The href is stashed behind a sentinel rather than
  // emitted inside angle brackets, because the generic tag stripper below would
  // otherwise treat "<https://...>" as a tag and delete it.
  const LINK_SENTINEL = '\u0000LINK\u0000';
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, href: string, label: string) => {
      const cleanHref = href.trim();
      const cleanLabel = label.replace(/<[^>]*>/g, '').trim();
      if (!cleanHref) return cleanLabel;
      if (!cleanLabel) return `${LINK_SENTINEL}${cleanHref}\u0001`;
      return `${cleanLabel} ${LINK_SENTINEL}${cleanHref}\u0001`;
    },
  );

  // Block-level elements become newlines.
  const BLOCKS =
    'address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';
  text = text.replace(new RegExp(`</?(${BLOCKS})\\b[^>]*>`, 'gi'), '\n');

  // Everything else is stripped.
  text = text.replace(/<[^>]*>/g, '');

  text = decodeHtmlEntities(text);

  // Normalize whitespace while preserving paragraph structure.
  text = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // Restore stashed link targets now that tag stripping is finished.
  text = text.replace(/\u0000LINK\u0000([^\u0001]+)\u0001/g, '<$1>');

  return text.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  bull: '-',
  middot: '.',
  copy: '(c)',
  reg: '(r)',
  trade: '(tm)',
  // Currency symbols are kept as the symbol itself. Expanding `&euro;` to the
  // three-letter code would corrupt amount detection in the attention engine,
  // which matches on `[$\u20ac\u00a3]` followed by a number.
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  deg: ' deg',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Parses a raw Gmail RFC822 message. Tolerates malformed input: any failure in
 * a sub-step degrades to an empty/partial value rather than throwing.
 */
export function parseRawEmail(raw: string): ParsedEmail {
  const blocks = splitHeaderBlocks(raw ?? '');
  const headerBlock = blocks[0] ?? '';
  const bodyBlock = blocks.slice(1).join('\n\n');
  const headers = parseHeaders(headerBlock);

  const fromList = parseAddressList(getHeader(headers, 'from') ?? '');
  const from = fromList[0] ?? { name: null, address: '' };

  const parts: MimePart[] = [];
  walkMime(bodyBlock, headers, 0, parts);

  let textBody = '';
  let htmlBody = '';
  for (const part of parts) {
    if (part.contentType === 'text/plain' && !textBody) {
      textBody = decodeMimeBody(part.body, part.charset, part.transferEncoding);
    } else if (part.contentType === 'text/html' && !htmlBody) {
      htmlBody = decodeMimeBody(part.body, part.charset, part.transferEncoding);
    }
  }

  if (!textBody && htmlBody) textBody = htmlToText(htmlBody);
  // Prefer plain text; fall back to converted HTML only when there is none.
  const finalText = textBody.trim().length > 0 ? textBody : htmlToText(htmlBody);

  return {
    headers,
    subject: decodeMimeWords(getHeader(headers, 'subject') ?? '').replace(/\s+/g, ' ').trim(),
    from: { name: from.name ? decodeMimeWords(from.name) : null, address: from.address },
    to: parseAddressList(getAllHeaders(headers, 'to').join(', ')).map((a) => a.address),
    cc: parseAddressList(getAllHeaders(headers, 'cc').join(', ')).map((a) => a.address),
    date: parseDateHeader(getHeader(headers, 'date')),
    textBody: finalText,
    htmlBody,
    parts,
  };
}

/**
 * Decodes a transfer-encoded part body. Handles base64, quoted-printable, and
 * 7bit/8bit. Never throws.
 */
export function decodeMimeBody(
  raw: string,
  charset: string,
  transferEncoding = '7bit',
): string {
  const encoding = transferEncoding.toLowerCase();
  if (encoding === 'base64') {
    const buf = decodeBase64(raw);
    return buf ? decodeTextBuffer(buf, charset) : '';
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(raw, charset);
  }
  return decodeTextBuffer(Buffer.from(raw, 'binary'), charset);
}

export function decodeQuotedPrintable(input: string, charset = 'utf-8'): string {
  const joined = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 255) {
        for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      } else {
        bytes.push(code);
      }
    }
  }
  return decodeTextBuffer(Buffer.from(bytes), charset);
}
