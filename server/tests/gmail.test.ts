import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GmailService } from '../src/mail/gmail.js';
import { MailError, type RawMessage } from '../src/mail/provider.js';
import { Database } from '../src/db/database.js';
import { loadConfig, GMAIL_READONLY_SCOPE } from '../src/config/env.js';
import * as repo from '../src/db/repositories.js';
import type { Clock } from '../src/util/clock.js';
import type { NormalizedEmail } from '../src/domain/types.js';

/**
 * The Gmail service is exercised against a faked googleapis surface. What is
 * verified here is the behaviour a real user depends on: token refresh,
 * pagination, error mapping, and that a single scope is ever requested.
 */

let dir: string;
let db: Database;
let now = new Date('2026-09-29T12:00:00.000Z');
const clock: Clock = { now: () => new Date(now) };

const CREDENTIALS = {
  clientId: 'test.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  redirectUri: 'http://localhost:8787/api/auth/google/callback',
};

interface FakeState {
  listCalls: { maxResults?: number; q?: string }[];
  getCalls: string[];
  threadCalls: string[];
  listResponse: { messages?: { id: string; threadId: string }[]; nextPageToken?: string };
  messageResponse: (id: string) => Record<string, unknown>;
  listError: { code?: number; errors?: { reason?: string }[] } | null;
  threadResponse: Record<string, unknown>;
  setCredentialsCalls: Record<string, unknown>[];
  refreshCount: number;
  refreshThrows: boolean;
}

function makeService(overrides: { configured?: boolean } = {}): {
  service: GmailService;
  state: FakeState;
} {
  const state: FakeState = {
    listCalls: [],
    getCalls: [],
    threadCalls: [],
    listResponse: { messages: [] },
    messageResponse: () => ({}),
    listError: null,
    threadResponse: { messages: [] },
    setCredentialsCalls: [],
    refreshCount: 0,
    refreshThrows: false,
  };

  const oauth = {
    generateAuthUrl: (opts: Record<string, unknown>) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${String(opts.state)}&scope=${String(opts.scope)}`,
    getToken: async () => ({
      tokens: { access_token: 'at-new', refresh_token: 'rt-new', expiry_date: now.getTime() + 3_600_000, scope: GMAIL_READONLY_SCOPE },
    }),
    setCredentials: (creds: Record<string, unknown>) => {
      state.setCredentialsCalls.push(creds);
    },
    refreshAccessToken: async () => {
      state.refreshCount += 1;
      if (state.refreshThrows) throw new Error('invalid_grant');
      return { tokens: { access_token: 'at-refreshed', expiry_date: now.getTime() + 3_600_000 } };
    },
  };

  const service = new GmailService({
    config: loadConfig({
      google: overrides.configured === false ? null : CREDENTIALS,
      gmailQuery: 'in:anywhere',
    }),
    db,
    clock,
    createOAuth2: () => oauth as never,
    createGmail: () =>
      ({
        users: {
          messages: {
            list: async (params: Record<string, unknown>) => {
              state.listCalls.push(params as never);
              if (state.listError) throw Object.assign(new Error('gmail'), state.listError);
              return { data: state.listResponse };
            },
            get: async (params: Record<string, unknown>) => {
              const id = String(params.id);
              state.getCalls.push(id);
              return { data: state.messageResponse(id) };
            },
          },
          threads: {
            get: async (params: Record<string, unknown>) => {
              state.threadCalls.push(String(params.id));
              return { data: state.threadResponse };
            },
          },
        },
      }) as never,
  });

  return { service, state };
}

function messagePayload(id: string, threadId: string): Record<string, unknown> {
  const raw = [
    'From: Priya Raman <priya@partner.example>',
    'To: demo@local.test',
    `Subject: Message ${id}`,
    'Date: Sat, 26 Sep 2026 10:00:00 +0000',
    '',
    'Please review this.',
  ].join('\r\n');

  return {
    id,
    threadId,
    internalDate: String(Date.parse('2026-09-26T10:00:00.000Z')),
    labelIds: ['INBOX'],
    snippet: 'Please review this.',
    raw: Buffer.from(raw, 'utf8').toString('base64url'),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pae-gmail-'));
  db = new Database(path.join(dir, 'test.db'));
  now = new Date('2026-09-29T12:00:00.000Z');
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function connect(): void {
  repo.saveTokens(db, {
    accessToken: 'at',
    refreshToken: 'rt',
    expiryMs: now.getTime() + 3_600_000,
    scope: GMAIL_READONLY_SCOPE,
    accountEmail: 'demo@local.test',
  });
}

describe('configuration', () => {
  it('reports not configured when there are no credentials', () => {
    const { service } = makeService({ configured: false });
    expect(service.isConfigured()).toBe(false);
  });

  it('reports configured with credentials', () => {
    const { service } = makeService();
    expect(service.isConfigured()).toBe(true);
  });

  it('reports no account before connecting', () => {
    const { service } = makeService();
    expect(service.getAccount()).toBeNull();
  });

  it('reports the account after connecting', () => {
    connect();
    const { service } = makeService();
    expect(service.getAccount()?.email).toBe('demo@local.test');
  });

  it('throws a clear, actionable error when Gmail is not configured', async () => {
    const { service } = makeService({ configured: false });
    try {
      await service.fetchRecentMessages(10);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MailError);
      const mailErr = err as MailError;
      expect(mailErr.code).toBe('not_configured');
      expect(mailErr.message).toContain('credentials.json');
      expect(mailErr.message).toContain('README');
    }
  });

  it('throws not_connected when there are no stored tokens', async () => {
    const { service } = makeService();
    await expect(service.fetchRecentMessages(10)).rejects.toMatchObject({ code: 'not_connected' });
  });
});

describe('OAuth', () => {
  it('requests offline access and the readonly scope', () => {
    const { service } = makeService();
    const url = service.getAuthorizationUrl('state123');
    expect(url).toContain('state=state123');
    expect(url).toContain(GMAIL_READONLY_SCOPE);
  });

  it('never requests a broader scope than gmail.readonly', () => {
    const { service } = makeService();
    const url = service.getAuthorizationUrl('s');
    for (const forbidden of ['gmail.send', 'gmail.modify', 'mail.google.com/', 'gmail.settings.basic']) {
      expect(url).not.toContain(forbidden);
    }
  });

  it('stores tokens after a code exchange', async () => {
    const { service } = makeService();
    await service.exchangeCode('valid-code-value-123');

    const stored = repo.loadTokens(db);
    expect(stored?.accessToken).toBe('at-new');
    expect(stored?.refreshToken).toBe('rt-new');
  });

  it('rejects a malformed code without calling Google', async () => {
    const { service } = makeService();
    await expect(service.exchangeCode('short')).rejects.toMatchObject({ code: 'invalid_code' });
  });

  it('clears tokens on disconnect', async () => {
    connect();
    const { service } = makeService();
    service.disconnect();
    expect(repo.loadTokens(db)).toBeNull();
    expect(service.getAccount()).toBeNull();
  });

  it('builds a Gmail deep link that is safe to hand to a browser', () => {
    const { service } = makeService();
    const url = service.getMessageUrl('abc123');
    expect(url).toBe('https://mail.google.com/mail/u/0/#all/abc123');
  });

  it('strips characters that are not valid in a Gmail message id', () => {
    const { service } = makeService();
    const url = service.getMessageUrl('abc/../123?x=1');
    expect(url).toBe('https://mail.google.com/mail/u/0/#all/abc123x1');
    expect(url).not.toContain('..');
  });
});

describe('token refresh', () => {
  it('does not refresh a token that is still valid', async () => {
    connect();
    const { service, state } = makeService();
    state.listResponse = { messages: [] };

    await service.fetchRecentMessages(10);
    expect(state.refreshCount).toBe(0);
  });

  it('refreshes an expired token before the request', async () => {
    connect();
    now = new Date('2026-09-30T12:00:00.000Z'); // past the stored expiry
    const { service, state } = makeService();
    state.listResponse = { messages: [] };

    await service.fetchRecentMessages(10);
    expect(state.refreshCount).toBe(1);
    expect(repo.loadTokens(db)?.accessToken).toBe('at-refreshed');
  });

  it('treats a revoked refresh token as disconnected rather than retrying', async () => {
    connect();
    now = new Date('2026-09-30T12:00:00.000Z');
    const { service, state } = makeService();
    state.refreshThrows = true;

    await expect(service.fetchRecentMessages(10)).rejects.toMatchObject({ code: 'token_revoked' });
    expect(repo.loadTokens(db)).toBeNull();
  });
});

describe('fetching messages', () => {
  it('returns an empty list for an empty inbox', async () => {
    connect();
    const { service } = makeService();
    expect(await service.fetchRecentMessages(50)).toEqual([]);
  });

  it('passes the configured query and limit to Gmail', async () => {
    connect();
    const { service, state } = makeService();
    await service.fetchRecentMessages(37);

    expect(state.listCalls[0].maxResults).toBe(37);
    expect(state.listCalls[0].q).toBe('in:anywhere');
  });

  it('clamps an absurd limit to a safe maximum', async () => {
    connect();
    const { service, state } = makeService();
    await service.fetchRecentMessages(100_000);
    expect(state.listCalls[0].maxResults).toBe(500);
  });

  it('fetches full messages and decodes the raw payload', async () => {
    connect();
    const { service, state } = makeService();
    state.listResponse = { messages: [{ id: 'm1', threadId: 't1' }] };
    state.messageResponse = (id) => messagePayload(id, 't1');

    const messages = await service.fetchRecentMessages(10);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
    expect(messages[0].raw).toContain('Subject: Message m1');
    expect(messages[0].internalDateMs).toBe(Date.parse('2026-09-26T10:00:00.000Z'));
  });

  it('skips a single message that fails without failing the batch', async () => {
    connect();
    const { service, state } = makeService();
    state.listResponse = {
      messages: [
        { id: 'ok1', threadId: 't1' },
        { id: 'bad', threadId: 't2' },
        { id: 'ok2', threadId: 't3' },
      ],
    };
    state.messageResponse = (id) => {
      if (id === 'bad') throw new Error('message unavailable');
      return messagePayload(id, 't');
    };

    const messages = await service.fetchRecentMessages(10);
    expect(messages.map((m) => m.id)).toEqual(['ok1', 'ok2']);
  });

  it('fetches a whole thread', async () => {
    connect();
    const { service, state } = makeService();
    state.threadResponse = { messages: [messagePayload('a', 't1'), messagePayload('b', 't1')] };

    const messages = await service.fetchThread('t1');
    expect(messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(state.threadCalls).toEqual(['t1']);
  });
});

describe('error mapping', () => {
  async function expectMailError(error: unknown, code: string, status: number): Promise<void> {
    connect();
    const { service, state } = makeService();
    state.listError = error as never;
    await expect(service.fetchRecentMessages(10)).rejects.toMatchObject({ code, status });
  }

  it('maps a quota error to rate_limited with a 429', async () => {
    await expectMailError({ code: 403, errors: [{ reason: 'rateLimitExceeded' }] }, 'rate_limited', 429);
  });

  it('maps a 429 to rate_limited', async () => {
    await expectMailError({ code: 429 }, 'rate_limited', 429);
  });

  it('maps an auth error to token_revoked with a 401', async () => {
    await expectMailError({ code: 401 }, 'token_revoked', 401);
  });

  it('maps a forbidden error to a 403 that explains the setup', async () => {
    connect();
    const { service, state } = makeService();
    state.listError = { code: 403, errors: [{ reason: 'insufficientPermissions' }] };

    await expect(service.fetchRecentMessages(10)).rejects.toMatchObject({ code: 'gmail_api_error' });
  });

  it('maps an unknown failure to a generic upstream error', async () => {
    await expectMailError({ code: 500 }, 'gmail_api_error', 502);
  });
});

describe('normalization', () => {
  it('produces a NormalizedEmail from a fetched message', async () => {
    connect();
    const { service, state } = makeService();
    state.listResponse = { messages: [{ id: 'm1', threadId: 't1' }] };
    state.messageResponse = (id) => messagePayload(id, 't1');

    const [raw] = await service.fetchRecentMessages(10);
    const email = service.normalize(raw);

    expect(email.id).toBe('m1');
    expect(email.fromAddress).toBe('priya@partner.example');
    expect(email.fromDomain).toBe('partner.example');
    expect(email.threadId).toBe('t1');
    expect(email.labels).toContain('INBOX');
  });

  it('normalizes a message with no raw payload without throwing', () => {
    const { service } = makeService();
    const raw: RawMessage = {
      id: 'm2',
      threadId: 't2',
      internalDateMs: Date.parse('2026-09-26T10:00:00.000Z'),
      snippet: 'only a snippet',
      labelIds: ['INBOX'],
      raw: null,
    };
    const email: NormalizedEmail = service.normalize(raw);
    expect(email.snippet).toBe('only a snippet');
    expect(email.subject).toBe('');
  });
});
