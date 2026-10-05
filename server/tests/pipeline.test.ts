import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pipeline } from '../src/pipeline/pipeline.js';
import { loadConfig } from '../src/config/env.js';
import { Database } from '../src/db/database.js';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import { EmitterNotificationService } from '../src/notifications/service.js';
import { systemClock } from '../src/util/clock.js';
import { toNormalizedEmail } from '../src/mail/normalize.js';
import * as repo from '../src/db/repositories.js';
import type { MailAccount, MailProvider, RawMessage } from '../src/mail/provider.js';
import type { NormalizedEmail } from '../src/domain/types.js';
import { loadFixtureMessages } from '../src/fixtures/mailProvider.js';

/**
 * Pipeline tests, focused on what the pipeline does to the fetched message set
 * before the engine ever sees it.
 */

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pae-pipeline-'));
  db = new Database(path.join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function config() {
  return loadConfig({
    dbPath: path.join(dir, 'test.db'),
    dataDir: dir,
    google: null,
    env: 'test',
    ai: { ...loadConfig().ai, mode: 'off', apiKey: null },
    attention: { messageLimit: 100, minConfidence: 0.55, notifyMode: 'off' },
  });
}

/**
 * A provider that can pretend to be Gmail's default query.
 *
 * `inboundOnly` reproduces the real failure mode: the list query excludes sent
 * mail (`-is:sent`), so a reply the user already wrote is not in the list, and
 * only an explicit thread fetch reveals it.
 */
class PartialThreadProvider implements MailProvider {
  readonly threadFetches: string[] = [];

  constructor(
    private readonly recent: RawMessage[],
    private readonly threads: Map<string, RawMessage[]>,
  ) {}

  isConfigured(): boolean {
    return true;
  }
  getAccount(): MailAccount {
    return { email: 'demo@local.test', scopes: ['fixture'] };
  }
  getAuthorizationUrl(): string {
    throw new Error('not used');
  }
  async exchangeCode(): Promise<MailAccount> {
    return this.getAccount();
  }
  async fetchRecentMessages(): Promise<RawMessage[]> {
    return this.recent;
  }
  async fetchThread(threadId: string): Promise<RawMessage[]> {
    this.threadFetches.push(threadId);
    return this.threads.get(threadId) ?? [];
  }
  getMessageUrl(id: string): string {
    return `https://mail.google.com/mail/u/0/#all/${id}`;
  }
  disconnect(): void {
    /* nothing to release */
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
}

function buildRun(mail: MailProvider): Pipeline {
  return new Pipeline({
    config: config(),
    db,
    clock: systemClock,
    mail,
    ai: new HeuristicProvider(),
    notifications: new EmitterNotificationService(),
  });
}

describe('thread hydration', () => {
  it('fetches the full thread so a sent reply is not invisible', async () => {
    const all = loadFixtureMessages(undefined, true);
    const threadId = 'fx-resolved-001';
    const thread = all.filter((m) => m.threadId === threadId);
    expect(thread.length).toBeGreaterThan(1);

    // The list returns only the first message, as if sent mail were excluded.
    const mail = new PartialThreadProvider(
      [thread[0]],
      new Map([[threadId, thread]]),
    );

    const summary = await buildRun(mail).run();

    expect(mail.threadFetches).toContain(threadId);
    // Both messages reached the engine, not just the one the list returned.
    expect(summary.fetched).toBe(thread.length);
    expect(summary.analysed).toBeGreaterThan(0);
  });

  it('does not duplicate a message that is both listed and fetched', async () => {
    const all = loadFixtureMessages(undefined, true);
    const threadId = 'fx-resolved-001';
    const thread = all.filter((m) => m.threadId === threadId);

    const mail = new PartialThreadProvider(thread, new Map([[threadId, thread]]));

    const summary = await buildRun(mail).run();

    expect(summary.fetched).toBe(thread.length);
  });

  it('analyzes what it has when a thread fetch fails', async () => {
    const all = loadFixtureMessages(undefined, true);
    const threadId = 'fx-resolved-001';
    const thread = all.filter((m) => m.threadId === threadId);

    const mail = new PartialThreadProvider(
      [thread[0]],
      // A missing thread reads as a fetch that returned nothing useful, which
      // must not take the whole run down.
      new Map(),
    );

    const summary = await buildRun(mail).run();

    expect(summary.fetched).toBe(1);
  });

  it('leaves an explicit source list untouched', async () => {
    const mail = new PartialThreadProvider([], new Map());
    const source = loadFixtureMessages(undefined, true).slice(0, 3);

    const summary = await buildRun(mail).run({ source });

    // The demo passes complete threads; re-fetching them would be wasted calls.
    expect(mail.threadFetches).toEqual([]);
    expect(summary.fetched).toBe(source.length);
  });
});

describe('suppressed verdicts are persisted', () => {
  it('records why each message was filtered, per message', async () => {
    const mail = new PartialThreadProvider(loadFixtureMessages(undefined, true), new Map());
    await buildRun(mail).run({ source: loadFixtureMessages(undefined, true) });

    const rows = db.all<{ suppression: string | null }>(
      `SELECT suppression FROM analyses WHERE is_attention = 0 AND suppression IS NOT NULL`,
    );

    // Without this the audit route can only report counts, not reasons.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.suppression && r.suppression.length > 0)).toBe(true);
  });

  it('does not create an item for a suppressed message', async () => {
    const source = loadFixtureMessages(undefined, true);
    const mail = new PartialThreadProvider(source, new Map());
    const summary = await buildRun(mail).run({ source });

    const open = repo.listItems(db, { statuses: ['open'], limit: 100 });
    expect(open.length).toBe(summary.newItems);
    // The newsletter and advertisement must not reach the feed.
    expect(open.some((i) => i.category === 'informational')).toBe(false);
  });
});