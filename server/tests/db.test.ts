import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db/database.js';
import * as repo from '../src/db/repositories.js';
import type { DeterministicVerdict, NormalizedEmail } from '../src/domain/types.js';
import { toNormalizedEmail } from '../src/mail/normalize.js';

/**
 * Database behaviour, against a real SQLite file rather than a mock, because
 * the things most likely to break (constraints, upserts, ordering) only break
 * in a real database.
 */

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pae-db-'));
  db = new Database(path.join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function email(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    id: 'm1',
    threadId: 't1',
    subject: 'Please verify your account',
    fromName: 'Support',
    fromAddress: 'support@x.example',
    fromDomain: 'x.example',
    to: ['demo@local.test'],
    cc: [],
    snippet: 'A snippet',
    bodyText: 'Please verify your account within 7 days.',
    bodyWasHtml: false,
    date: new Date('2026-09-28T09:00:00.000Z'),
    labels: ['INBOX'],
    gmailCategory: null,
    listUnsubscribe: false,
    listId: null,
    precedence: null,
    messageIdHeader: null,
    inReplyTo: null,
    references: [],
    ...overrides,
  };
}

function verdict(overrides: Partial<DeterministicVerdict> = {}): DeterministicVerdict {
  return {
    isAttentionItem: true,
    category: 'verification',
    priority: 'high',
    title: 'Verification required',
    summary: 'Please verify.',
    whyItMatters: 'Account may be limited.',
    recommendedAction: 'Open and verify.',
    deadline: { iso: '2026-10-05T09:00:00.000Z', raw: 'within 7 days', kind: 'relative', confidence: 0.75 },
    confidence: 0.9,
    signals: [{ kind: 'action_request', evidence: 'please verify', weight: 0.9 }],
    suppressionReason: null,
    ...overrides,
  };
}

describe('messages', () => {
  it('stores and reads back a message', () => {
    repo.upsertMessage(db, { email: email(), isNoise: false, noiseKind: null, bodyExcerptChars: 600 });

    const stored = repo.getMessage(db, 'm1');
    expect(stored?.subject).toBe('Please verify your account');
    expect(stored?.labels).toEqual(['INBOX']);
    expect(stored?.isNoise).toBe(false);
  });

  it('caps the stored body excerpt at the configured length', () => {
    repo.upsertMessage(db, {
      email: email({ bodyText: 'x'.repeat(5000) }),
      isNoise: false,
      noiseKind: null,
      bodyExcerptChars: 200,
    });
    const stored = repo.getMessage(db, 'm1');
    expect(stored!.bodyExcerpt.length).toBeLessThanOrEqual(203);
  });

  it('does not store the full body', () => {
    const body = 'secret sentence that should never be stored verbatim';
    repo.upsertMessage(db, { email: email({ bodyText: body }), isNoise: false, noiseKind: null, bodyExcerptChars: 40 });
    const raw = fs.readFileSync(path.join(dir, 'test.db'));
    expect(raw.includes(Buffer.from(body))).toBe(false);
  });

  it('upserts rather than duplicating', () => {
    repo.upsertMessage(db, { email: email(), isNoise: false, noiseKind: null, bodyExcerptChars: 600 });
    repo.upsertMessage(db, {
      email: email({ subject: 'Updated subject' }),
      isNoise: false,
      noiseKind: null,
      bodyExcerptChars: 600,
    });
    expect(db.all('SELECT * FROM messages')).toHaveLength(1);
    expect(repo.getMessage(db, 'm1')?.subject).toBe('Updated subject');
  });

  it('lists message ids for a thread in chronological order', () => {
    repo.upsertMessage(db, { email: email({ id: 'm2', date: new Date('2026-09-02') }), isNoise: false, noiseKind: null, bodyExcerptChars: 600 });
    repo.upsertMessage(db, { email: email({ id: 'm1', date: new Date('2026-09-01') }), isNoise: false, noiseKind: null, bodyExcerptChars: 600 });
    expect(repo.getMessageIdsByThread(db, 't1')).toEqual(['m1', 'm2']);
  });
});

describe('analyses', () => {
  it('stores an analysis and marks the message analysed', () => {
    repo.upsertMessage(db, { email: email(), isNoise: false, noiseKind: null, bodyExcerptChars: 600 });
    repo.saveAnalysis(db, 'm1', 't1', verdict(), 'hybrid');

    const stored = repo.getAnalysis(db, 'm1');
    expect(stored?.isAttention).toBe(true);
    expect(stored?.category).toBe('verification');
    expect(stored?.deadlineIso).toBe('2026-10-05T09:00:00.000Z');
    expect(repo.getMessage(db, 'm1')?.analysedAt).not.toBeNull();
  });

  it('replaces an analysis on re-run', () => {
    repo.upsertMessage(db, { email: email(), isNoise: false, noiseKind: null, bodyExcerptChars: 600 });
    repo.saveAnalysis(db, 'm1', 't1', verdict({ priority: 'high' }), 'rules');
    repo.saveAnalysis(db, 'm1', 't1', verdict({ priority: 'low', suppressionReason: 'noise' }), 'rules');

    expect(db.all('SELECT * FROM analyses')).toHaveLength(1);
    expect(repo.getAnalysis(db, 'm1')?.priority).toBe('low');
  });

  it('returns null for an unknown message', () => {
    expect(repo.getAnalysis(db, 'nope')).toBeNull();
  });
});

describe('attention items', () => {
  function newItem(overrides: Partial<repo.NewItem> = {}): repo.NewItem {
    return {
      id: 'i1',
      eventKey: 'verification::abc::123::t1',
      threadId: 't1',
      sourceMessageId: 'm1',
      sourceThreadId: 't1',
      category: 'verification',
      priority: 'high',
      confidence: 0.9,
      title: 'Verification required',
      summary: 'Please verify.',
      why: 'Account may be limited.',
      action: 'Open and verify.',
      deadlineIso: '2026-10-05T09:00:00.000Z',
      deadlineRaw: 'within 7 days',
      status: 'open',
      resolvedReason: null,
      decidedBy: 'hybrid',
      ...overrides,
    };
  }

  it('inserts and retrieves an item', () => {
    const created = repo.insertItem(db, newItem());
    expect(created.id).toBe('i1');
    expect(created.status).toBe('open');
    expect(repo.getItem(db, 'i1')?.title).toBe('Verification required');
  });

  it('enforces the event key uniqueness that prevents duplicates', () => {
    repo.insertItem(db, newItem());
    expect(() => repo.insertItem(db, newItem({ id: 'i2' }))).toThrow();
  });

  it('finds an item by event key', () => {
    repo.insertItem(db, newItem());
    expect(repo.findItemByEventKey(db, 'verification::abc::123::t1')?.id).toBe('i1');
    expect(repo.findItemByEventKey(db, 'other')).toBeNull();
  });

  it('orders by priority, then confidence, then deadline', () => {
    repo.insertItem(db, newItem({ id: 'low', eventKey: 'k1', priority: 'low' }));
    repo.insertItem(db, newItem({ id: 'high', eventKey: 'k2', priority: 'high' }));
    repo.insertItem(db, newItem({ id: 'med', eventKey: 'k3', priority: 'medium' }));

    expect(repo.listItems(db, { statuses: ['open'] }).map((i) => i.id)).toEqual([
      'high',
      'med',
      'low',
    ]);
  });

  it('filters by status', () => {
    repo.insertItem(db, newItem({ id: 'a', eventKey: 'ka' }));
    repo.insertItem(db, newItem({ id: 'b', eventKey: 'kb' }));
    repo.updateItemStatus(db, 'b', 'handled');

    expect(repo.listItems(db, { statuses: ['open'] }).map((i) => i.id)).toEqual(['a']);
    expect(repo.listItems(db, { statuses: ['handled'] }).map((i) => i.id)).toEqual(['b']);
    expect(repo.listItems(db, { statuses: ['open', 'handled'] })).toHaveLength(2);
  });

  it('counts only open items', () => {
    repo.insertItem(db, newItem({ id: 'a', eventKey: 'ka' }));
    repo.insertItem(db, newItem({ id: 'b', eventKey: 'kb' }));
    repo.updateItemStatus(db, 'b', 'dismissed');
    expect(repo.countOpenItems(db)).toBe(1);
  });

  it('records an event history for status changes', () => {
    repo.insertItem(db, newItem());
    repo.updateItemStatus(db, 'i1', 'handled', 'Marked handled by you.');

    const events = repo.listItemEvents(db, 'i1');
    expect(events.map((e) => e.kind)).toEqual(['created', 'status:handled']);
    expect(repo.getItem(db, 'i1')?.resolvedReason).toBe('Marked handled by you.');
  });

  it('lists only unnotified open items above the confidence floor', () => {
    repo.insertItem(db, newItem({ id: 'a', eventKey: 'ka', confidence: 0.9 }));
    repo.insertItem(db, newItem({ id: 'b', eventKey: 'kb', confidence: 0.4 }));
    repo.insertItem(db, newItem({ id: 'c', eventKey: 'kc' }));
    repo.markNotified(db, 'c');

    const pending = repo.listUnnotifiedOpenItems(db, 0.55);
    expect(pending.map((i) => i.id)).toEqual(['a']);
  });

  it('reopens an item', () => {
    repo.insertItem(db, newItem());
    repo.updateItemStatus(db, 'i1', 'dismissed', 'Dismissed by you.');
    const reopened = repo.updateItemStatus(db, 'i1', 'open', null);
    expect(reopened?.status).toBe('open');
    expect(reopened?.resolvedReason).toBeNull();
  });

  it('deletes an item and its events', () => {
    repo.insertItem(db, newItem());
    expect(repo.deleteItem(db, 'i1')).toBe(true);
    expect(repo.getItem(db, 'i1')).toBeNull();
    expect(repo.deleteItem(db, 'i1')).toBe(false);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) {
      repo.insertItem(db, newItem({ id: `i${i}`, eventKey: `k${i}` }));
    }
    expect(repo.listItems(db, { statuses: ['open'], limit: 3 })).toHaveLength(3);
  });

  it('stores text safely rather than interpreting it', () => {
    const nasty = `'); DROP TABLE items; -- <script>alert(1)</script>`;
    repo.insertItem(db, newItem({ title: nasty }));
    expect(repo.getItem(db, 'i1')?.title).toBe(nasty);
    expect(db.all('SELECT * FROM items')).toHaveLength(1);
  });
});

describe('tokens', () => {
  it('returns null when nothing is stored', () => {
    expect(repo.loadTokens(db)).toBeNull();
  });

  it('stores and loads tokens', () => {
    repo.saveTokens(db, {
      accessToken: 'at',
      refreshToken: 'rt',
      expiryMs: 123,
      scope: 'gmail.readonly',
      accountEmail: 'demo@local.test',
    });
    const loaded = repo.loadTokens(db);
    expect(loaded?.refreshToken).toBe('rt');
    expect(loaded?.accountEmail).toBe('demo@local.test');
  });

  it('keeps a single token row across repeated saves', () => {
    repo.saveTokens(db, { accessToken: 'a1', refreshToken: 'r1', expiryMs: 1, scope: null, accountEmail: null });
    repo.saveTokens(db, { accessToken: 'a2', refreshToken: 'r2', expiryMs: 2, scope: null, accountEmail: null });
    expect(db.all('SELECT * FROM tokens')).toHaveLength(1);
    expect(repo.loadTokens(db)?.accessToken).toBe('a2');
  });

  it('clears tokens on disconnect', () => {
    repo.saveTokens(db, { accessToken: 'a', refreshToken: 'r', expiryMs: 1, scope: null, accountEmail: null });
    repo.clearTokens(db);
    expect(repo.loadTokens(db)).toBeNull();
  });
});

describe('runs', () => {
  it('records a completed run', () => {
    repo.startRun(db, 'run1');
    repo.finishRun(db, 'run1', { fetched: 100, analysed: 20, itemsOpen: 3, aiCalls: 2 });

    const last = repo.lastRun(db);
    expect(last?.id).toBe('run1');
    expect(last?.fetched).toBe(100);
    expect(last?.finishedAt).not.toBeNull();
    expect(last?.degraded).toBe(false);
  });

  it('records a failed run with its error', () => {
    repo.startRun(db, 'run2');
    repo.finishRun(db, 'run2', { error: 'Gmail rejected the request', degraded: true });
    expect(repo.lastRun(db)?.error).toBe('Gmail rejected the request');
    expect(repo.lastRun(db)?.degraded).toBe(true);
  });

  it('returns null before any run', () => {
    expect(repo.lastRun(db)).toBeNull();
  });
});

describe('transactions', () => {
  it('rolls back on failure so a partial run leaves no orphans', () => {
    repo.insertItem(db, {
      id: 'ok',
      eventKey: 'k-ok',
      threadId: null,
      sourceMessageId: 'm1',
      sourceThreadId: null,
      category: 'verification',
      priority: 'high',
      confidence: 0.9,
      title: 'ok',
      summary: '',
      why: '',
      action: '',
      deadlineIso: null,
      deadlineRaw: null,
      status: 'open',
      resolvedReason: null,
      decidedBy: 'rules',
    });

    expect(() =>
      db.transaction(() => {
        repo.insertItem(db, { ...({} as repo.NewItem), id: 'x', eventKey: 'kx' });
        throw new Error('boom');
      }),
    ).toThrow();

    expect(repo.getItem(db, 'x')).toBeNull();
    expect(repo.getItem(db, 'ok')).not.toBeNull();
  });
});

describe('in-memory database', () => {
  it('supports the full schema', () => {
    const mem = new Database(':memory:');
    const tables = mem.all("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.length).toBeGreaterThan(3);
    mem.close();
  });
});
