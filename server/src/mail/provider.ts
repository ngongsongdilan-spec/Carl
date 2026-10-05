import type { NormalizedEmail } from '../domain/types.js';

/**
 * The mail boundary.
 *
 * The engine and pipeline depend only on this interface. Gmail is the
 * implementation; Outlook, IMAP, or a fixture directory would be another class
 * implementing the same five methods.
 */

export interface RawMessage {
  id: string;
  threadId: string;
  internalDateMs: number | null;
  snippet: string | null;
  labelIds: string[];
  raw: string | null;
}

export interface MailAccount {
  email: string | null;
  scopes: string[];
}

export interface MailProvider {
  /** True when the provider has usable credentials locally. */
  isConfigured(): boolean;
  /** The account currently authorized, or null. */
  getAccount(): MailAccount | null;
  /** URL the browser should be sent to in order to authorize. */
  getAuthorizationUrl(state: string): string;
  /** Exchanges an authorization code for tokens. */
  exchangeCode(code: string): Promise<MailAccount>;
  /** Fetches up to `limit` recent messages, newest first. */
  fetchRecentMessages(limit: number): Promise<RawMessage[]>;
  /** Fetches a full thread (all messages, oldest first). */
  fetchThread(threadId: string): Promise<RawMessage[]>;
  /** Deep link that opens a message in the provider's web UI. */
  getMessageUrl(messageId: string): string;
  /** Releases credentials. */
  disconnect(): void;
  /** Converts a provider message into the engine's input shape. */
  normalize(message: RawMessage): NormalizedEmail;
}

export class MailError extends Error {
  readonly code:
    | 'not_configured'
    | 'not_connected'
    | 'invalid_code'
    | 'token_revoked'
    | 'gmail_api_error'
    | 'rate_limited'
    | 'network_error';

  readonly status: number;

  constructor(code: MailError['code'], message: string, status = 502) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.status = status;
  }
}
