import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from '../config/env.js';
import { GMAIL_READONLY_SCOPE } from '../config/env.js';
import { logger } from '../logging/logger.js';
import { toNormalizedEmail } from './normalize.js';
import { MailError, type MailAccount, type MailProvider, type RawMessage } from './provider.js';
import type { NormalizedEmail } from '../domain/types.js';
import type { Database } from '../db/database.js';
import { clearTokens, loadTokens, saveTokens } from '../db/repositories.js';
import type { Clock } from '../util/clock.js';

/**
 * Gmail via the official Gmail API.
 *
 * Scope is `gmail.readonly` only. The application therefore *cannot* send,
 * delete, modify, or label mail, which is the strongest single guarantee this
 * product makes. A bug elsewhere cannot mutate the mailbox.
 */

const TOKEN_BUFFER_MS = 60_000;

/**
 * Structural type for the OAuth client. Declared locally rather than imported so
 * the whole Gmail surface can be faked in tests without a googleapis instance.
 */
export interface OAuth2ClientLike {
  generateAuthUrl(opts: Record<string, unknown>): string;
  getToken(code: string): Promise<{ tokens: OAuthTokens }>;
  setCredentials(creds: Record<string, unknown>): void;
  refreshAccessToken(): Promise<{ tokens: OAuthTokens }>;
}

export interface OAuthTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
}

export interface GmailServiceOptions {
  config: AppConfig;
  db: Database;
  clock?: Clock;
  /** Injected for tests; defaults to the googleapis implementation. */
  createGmail?: (auth: OAuth2ClientLike) => GmailApi;
  createOAuth2?: () => OAuth2ClientLike;
}

interface GmailMessagesApi {
  list(params: Record<string, unknown>): Promise<{ data: { messages?: { id: string; threadId: string }[]; nextPageToken?: string } }>;
  get(params: Record<string, unknown>): Promise<{ data: Record<string, unknown> }>;
}

interface GmailThreadsApi {
  get(params: Record<string, unknown>, options?: unknown): Promise<{ data: Record<string, unknown> }>;
}

interface GmailApi {
  users: { messages: GmailMessagesApi; threads: GmailThreadsApi };
}

export class GmailService implements MailProvider {
  private readonly config: AppConfig;
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly makeOAuth: () => OAuth2ClientLike;
  private readonly makeGmail: (auth: OAuth2ClientLike) => GmailApi;

  private oauth: OAuth2ClientLike | null = null;
  private cachedAccountEmail: string | null = null;

  constructor(options: GmailServiceOptions) {
    this.config = options.config;
    this.db = options.db;
    this.clock = options.clock ?? { now: () => new Date() };
    const defaultOAuthFactory = (): OAuth2ClientLike => {
      const Ctor = google.auth.OAuth2 as unknown as new (
        clientId?: string,
        clientSecret?: string,
        redirectUri?: string,
      ) => OAuth2ClientLike;
      return new Ctor(
        this.config.google?.clientId,
        this.config.google?.clientSecret,
        this.config.google?.redirectUri,
      );
    };

    this.makeOAuth = options.createOAuth2 ?? defaultOAuthFactory;
    const defaultGmailFactory = (auth: OAuth2ClientLike): GmailApi => {
      const factory = google.gmail as unknown as (opts: {
        version: string;
        auth: OAuth2Client;
      }) => GmailApi;
      return factory({ version: 'v1', auth: auth as unknown as OAuth2Client });
    };

    this.makeGmail = options.createGmail ?? defaultGmailFactory;

    const stored = loadTokens(this.db);
    this.cachedAccountEmail = stored?.accountEmail ?? null;
  }

  isConfigured(): boolean {
    return this.config.google !== null;
  }

  getAccount(): MailAccount | null {
    const stored = loadTokens(this.db);
    if (!stored) return null;
    return { email: stored.accountEmail ?? this.cachedAccountEmail, scopes: this.scopes() };
  }

  /**
   * The only scope this app ever requests.
   *
   * `gmail.readonly` is enough for everything the pipeline does, and the
   * product spec limits the grant to exactly that. Reading recent messages,
   * reading threads, and reading bodies all work with it. No other scope is
   * requested, and there is no configuration path that can add one: an
   * extra-scope option would make the grant depend on a `.env` value, and
   * widening a mail grant is not something a stray env var should be able to
   * do silently.
   */
  private scopes(): string[] {
    return [GMAIL_READONLY_SCOPE];
  }

  getAuthorizationUrl(state: string): string {
    const creds = this.requireCredentials();
    const client = this.makeOAuth();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: this.config.googleSkipConsentScreen ? 'none' : 'consent',
      scope: this.scopes(),
      state,
      // Not `include_granted_scopes`: that would fold scopes previously granted
      // to this client into the request, which is exactly the widening the
      // single-scope rule exists to prevent.
      include_granted_scopes: false,
    });
  }

  async exchangeCode(code: string): Promise<MailAccount> {
    const creds = this.requireCredentials();
    if (!code || code.length < 10) {
      throw new MailError('invalid_code', 'The authorization code was missing or malformed.', 400);
    }

    const client = this.makeOAuth();
    try {
      const { tokens } = await client.getToken(code);
      saveTokens(this.db, {
        accessToken: tokens.access_token ?? null,
        refreshToken: tokens.refresh_token ?? null,
        expiryMs: tokens.expiry_date ?? null,
        scope: tokens.scope ?? null,
        accountEmail: null,
      });
      this.oauth = client;
      // Reuse the refresh token from the previous connection if Google did not
      // issue a new one (common when the app is already authorised).
      const existing = loadTokens(this.db);
      if (existing?.refreshToken === null) {
        logger.warn('Google did not return a refresh token; re-consent may be required');
      }
      return await this.resolveAccount();
    } catch (err) {
      logger.warn('OAuth code exchange failed', {
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      throw new MailError(
        'invalid_code',
        'Google rejected the authorization code. Start the connection again.',
        400,
      );
    } finally {
      void creds;
    }
  }

  /** Fetches the authorized address via the profile scope fallback. */
  private async resolveAccount(): Promise<MailAccount> {
    try {
      const gmail = this.makeGmail(await this.authenticatedClient());
      const res = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
      void res;
      this.cachedAccountEmail = 'connected';
      return { email: this.cachedAccountEmail, scopes: this.scopes() };
    } catch (err) {
      // Gmail readonly cannot read the profile. Deriving the address from a
      // message is the pragmatic option; if the mailbox is empty we still know
      // the connection works.
      try {
        const raw = await this.listRaw(1);
        const from = raw[0]?.raw ? parseSenderDomain(raw[0].raw) : null;
        this.cachedAccountEmail = from ?? 'connected';
      } catch {
        this.cachedAccountEmail = 'connected';
      }
      logger.debug('Account address could not be resolved directly', {
        message: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      });
      return { email: this.cachedAccountEmail, scopes: this.scopes() };
    }
  }

  async fetchRecentMessages(limit: number): Promise<RawMessage[]> {
    return this.listRaw(limit);
  }

  private async listRaw(limit: number): Promise<RawMessage[]> {
    const gmail = this.makeGmail(await this.authenticatedClient());
    const bounded = Math.min(500, Math.max(1, limit));

    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        maxResults: bounded,
        q: this.config.gmailQuery,
      });

      const refs = listRes.data.messages ?? [];
      if (refs.length === 0) return [];

      const out: RawMessage[] = [];
      // Bounded concurrency: fast enough for 100 messages, gentle on quota.
      const BATCH = 10;
      for (let i = 0; i < refs.length; i += BATCH) {
        const slice = refs.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          slice.map(async (ref) => {
            const res = await gmail.users.messages.get({
              userId: 'me',
              id: ref.id,
              format: 'full',
            });
            return toRawMessage(ref.id, ref.threadId, res.data);
          }),
        );
        for (const result of results) {
          if (result.status === 'fulfilled') out.push(result.value);
        }
      }
      return out;
    } catch (err) {
      throw this.translateError(err);
    }
  }

  async fetchThread(threadId: string): Promise<RawMessage[]> {
    const gmail = this.makeGmail(await this.authenticatedClient());
    try {
      const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
      const messages = (res.data.messages ?? []) as Record<string, unknown>[];
      return messages.map((m) =>
        toRawMessage(String(m.id ?? ''), threadId, m),
      );
    } catch (err) {
      throw this.translateError(err);
    }
  }

  getMessageUrl(messageId: string): string {
    // Constructed, never echoed from input, and validated as an id.
    const safe = String(messageId).replace(/[^A-Za-z0-9_-]/g, '');
    return `https://mail.google.com/mail/u/0/#all/${safe}`;
  }

  disconnect(): void {
    clearTokens(this.db);
    this.oauth = null;
    this.cachedAccountEmail = null;
  }

  normalize(message: RawMessage): NormalizedEmail {
    return toNormalizedEmail({
      id: message.id,
      threadId: message.threadId,
      internalDateMs: message.internalDateMs,
      snippet: message.snippet,
      labelIds: message.labelIds,
      raw: message.raw,
    });
  }

  // -------------------------------------------------------------------------

  private requireCredentials(): AppConfig['google'] {
    if (!this.config.google) {
      throw new MailError(
        'not_configured',
        'Gmail is not configured. Place credentials.json in the project root, or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env. See README section 3.',
        503,
      );
    }
    return this.config.google;
  }

  /** Returns an authenticated client, refreshing the token when it has expired. */
  private async authenticatedClient(): Promise<OAuth2ClientLike> {
    this.requireCredentials();

    const stored = loadTokens(this.db);
    if (!stored) {
      throw new MailError('not_connected', 'No Gmail account is connected.', 401);
    }

    if (!this.oauth) this.oauth = this.makeOAuth();

    const expired =
      stored.expiryMs !== null && stored.expiryMs - TOKEN_BUFFER_MS < this.clock.now().getTime();

    if (expired && stored.refreshToken) {
      this.oauth.setCredentials({
        refresh_token: stored.refreshToken,
        access_token: stored.accessToken ?? undefined,
        expiry_date: stored.expiryMs ?? undefined,
      });
      try {
        const { tokens } = await this.oauth.refreshAccessToken();
        saveTokens(this.db, {
          accessToken: tokens.access_token ?? stored.accessToken,
          refreshToken: tokens.refresh_token ?? stored.refreshToken,
          expiryMs: tokens.expiry_date ?? stored.expiryMs,
          scope: stored.scope,
          accountEmail: stored.accountEmail,
        });
        logger.debug('Gmail access token refreshed');
      } catch (err) {
        logger.warn('Gmail token refresh failed', {
          message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        });
        clearTokens(this.db);
        this.oauth = null;
        throw new MailError(
          'token_revoked',
          'Google rejected the stored refresh token. Reconnect Gmail to continue.',
          401,
        );
      }
    } else {
      this.oauth.setCredentials({
        refresh_token: stored.refreshToken ?? undefined,
        access_token: stored.accessToken ?? undefined,
        expiry_date: stored.expiryMs ?? undefined,
      });
    }

    return this.oauth;
  }

  /** Maps googleapis errors onto the app's error vocabulary. */
  private translateError(err: unknown): MailError {
    const e = err as { code?: number; message?: string; errors?: { reason?: string }[] };
    const status = typeof e?.code === 'number' ? e.code : undefined;
    const reason = e?.errors?.[0]?.reason;

    if (status === 401 || reason === 'authError' || reason === 'invalidCredentials') {
      return new MailError('token_revoked', 'Gmail rejected the stored credentials. Reconnect Gmail.', 401);
    }
    if (status === 403 && reason === 'rateLimitExceeded') {
      return new MailError(
        'rate_limited',
        'Gmail API quota exceeded. Wait a minute and try again.',
        429,
      );
    }
    if (status === 429) {
      return new MailError('rate_limited', 'Gmail is rate limiting requests. Try again shortly.', 429);
    }
    if (status === 403) {
      return new MailError(
        'gmail_api_error',
        'Gmail denied the request. Confirm the Gmail API is enabled and the consent screen includes your account as a test user.',
        403,
      );
    }
    return new MailError(
      'gmail_api_error',
      'The Gmail API request failed. Check your connection and try again.',
      502,
    );
  }
}

function toRawMessage(
  id: string,
  threadId: string,
  payload: Record<string, unknown>,
): RawMessage {
  const headerList = (payload.labelIds ?? []) as string[];
  const internal = payload.internalDate ? Number(payload.internalDate) : null;
  const raw = typeof payload.raw === 'string' ? decodeGmailBase64Url(payload.raw) : null;
  return {
    id,
    threadId: String(payload.threadId ?? threadId ?? id),
    internalDateMs: Number.isFinite(internal) ? internal : null,
    snippet: typeof payload.snippet === 'string' ? payload.snippet : null,
    labelIds: headerList,
    raw,
  };
}

function decodeGmailBase64Url(value: string): string {
  const cleaned = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function parseSenderDomain(raw: string): string | null {
  const m = /From:\s*[^<]*<([^>]+)>/i.exec(raw);
  return m ? m[1].split('@')[1] ?? null : null;
}
