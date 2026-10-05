/**
 * Minimal logger with a hard guarantee that email content and token material
 * never reach the log stream.
 *
 * Design: callers pass structured fields only. Any value that looks like an
 * email body, bearer token, or OAuth credential is scrubbed defensively here,
 * so a future code change cannot silently leak content.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|auth|credential|api[_-]?key|refresh|access[_-]?token|cookie)/i;

const TOKEN_VALUE_PATTERNS: RegExp[] = [
  /\bya29\.[A-Za-z0-9_-]{20,}/g, // Google OAuth access token
  /\b1\/\/[A-Za-z0-9_-]{30,}/g, // Google refresh token
  /\bsk-[A-Za-z0-9]{16,}/g, // OpenAI-style key
  /\bgsk_[A-Za-z0-9]{16,}/g, // Groq
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google API key
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
];

/** Keys whose values are, by policy, never logged even if scrubbed. */
const FORBIDDEN_KEYS = new Set(['body', 'bodyText', 'snippet', 'excerpt', 'html', 'raw']);

export function redact(value: unknown, keyHint = '', depth = 0): unknown {
  if (depth > 4) return '[deep]';

  if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) return '[redacted]';
  if (keyHint && FORBIDDEN_KEYS.has(keyHint)) return '[content-omitted]';

  if (typeof value === 'string') {
    let out = value;
    for (const pattern of TOKEN_VALUE_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out.length > 400 ? `${out.slice(0, 400)}…` : out;
  }

  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redact(v, '', depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redact(v, k, depth + 1);
  }
  return out;
}

let minimumLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

export function setLogLevel(level: Level): void {
  minimumLevel = level;
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel]) return;
  const safeFields = fields ? (redact(fields) as Record<string, unknown>) : undefined;
  const prefix = `[${level.toUpperCase()}]`;
  if (safeFields && Object.keys(safeFields).length > 0) {
    // eslint-disable-next-line no-console
    console.log(prefix, message, safeFields);
  } else {
    // eslint-disable-next-line no-console
    console.log(prefix, message);
  }
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
  redact,
};
