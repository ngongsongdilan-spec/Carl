/**
 * Typed application errors.
 *
 * Every error that reaches a client is one of these, so the API never leaks a
 * stack trace or an internal message. `hint` is written for the person using
 * the app, not for a developer reading a stack trace.
 */

export type ErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'not_configured'
  | 'not_connected'
  | 'invalid_credentials'
  | 'token_expired'
  | 'rate_limited'
  | 'upstream_error'
  | 'ai_unavailable'
  | 'internal_error'
  | 'conflict';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string | null;

  constructor(code: ErrorCode, message: string, status = 400, hint: string | null = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }

  toJSON(): { error: { code: ErrorCode; message: string; hint: string | null } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
      },
    };
  }
}

export function badRequest(message: string, hint?: string): AppError {
  return new AppError('bad_request', message, 400, hint ?? null);
}

export function notFound(message: string, hint?: string): AppError {
  return new AppError('not_found', message, 404, hint ?? null);
}

export function notConfigured(message: string, hint?: string): AppError {
  return new AppError('not_configured', message, 503, hint ?? null);
}

export function notConnected(message: string, hint?: string): AppError {
  return new AppError('not_connected', message, 401, hint ?? null);
}

export function aiUnavailable(message: string, hint?: string): AppError {
  return new AppError('ai_unavailable', message, 503, hint ?? null);
}

export function upstream(code: ErrorCode, message: string, status = 502, hint?: string): AppError {
  return new AppError(code, message, status, hint ?? null);
}

/** Converts a MailError into an AppError without losing its meaning. */
export function fromMailError(err: unknown): AppError {
  const e = err as { code?: string; message?: string; status?: number; name?: string };
  if (e?.name !== 'MailError') {
    return new AppError('internal_error', 'An unexpected error occurred.', 500);
  }

  const codeMap: Record<string, ErrorCode> = {
    not_configured: 'not_configured',
    not_connected: 'not_connected',
    invalid_code: 'invalid_credentials',
    token_revoked: 'token_expired',
    gmail_api_error: 'upstream_error',
    rate_limited: 'rate_limited',
    network_error: 'upstream_error',
  };

  return new AppError(
    codeMap[e.code ?? ''] ?? 'upstream_error',
    e.message ?? 'The mail provider returned an error.',
    e.status ?? 502,
  );
}
