import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/api/app.js';
import { createContext } from '../src/index.js';
import { loadConfig } from '../src/config/env.js';
import * as repo from '../src/db/repositories.js';
import { FixtureProvider, loadFixtureMessages } from '../src/fixtures/mailProvider.js';
import type { AppContext } from '../src/api/handler.js';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import { EmitterNotificationService } from '../src/notifications/service.js';
import { AttentionEngine } from '../src/attention/engine.js';
import { toNormalizedEmail } from '../src/mail/normalize.js';
import { extractDeadline, daysUntil, formatDeadlineForDisplay, isDeadlinePassed } from '../src/attention/deadlines.js';
import { fixedClock } from '../src/util/clock.js';

/**
 * API tests run against the real Express app with a temporary SQLite database.
 * Nothing is stubbed at the HTTP layer, so routing, middleware, error shapes,
 * and status codes are all covered.
 */

let dir: string;
let ctx: AppContext;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pae-api-'));
  const config = loadConfig({
    dbPath: path.join(dir, 'test.db'),
    dataDir: dir,
    google: null,
    env: 'test',
    webAppUrl: 'http://localhost:5173',
    ai: { ...loadConfig().ai, mode: 'off', apiKey: null },
    attention: { messageLimit: 100, minConfidence: 0.55, notifyMode: 'off' },
  });

  ctx = createContext(config);
  // Same loader the app uses for its demo inbox: shifted dates, so the demo
  // fixtures' deadlines stay live. These tests never touch Gmail.
  ctx.demoMessages = loadFixtureMessages(undefined, true);
  app = createApp(ctx);
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('reports the service state', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.gmailConfigured).toBe(false);
    expect(res.body.gmailConnected).toBe(false);
  });

  it('never leaks token material', async () => {
    const res = await request(app).get('/api/health').expect(200);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('refresh');
    expect(serialised).not.toContain('access_token');
  });
});

describe('GET /api/config', () => {
  it('reports AI mode without exposing the key', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.ai.mode).toBe('off');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|apiKey/);
  });

  it('reports demo mode when Gmail is not configured', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.demoMode).toBe(true);
  });
});

describe('GET /api/auth/status', () => {
  it('reports not configured with an actionable hint', async () => {
    const res = await request(app).get('/api/auth/status').expect(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.connected).toBe(false);
    expect(res.body.setupHint).toContain('credentials.json');
  });

  it('returns no token material even when connected', async () => {
    // Simulate a stored connection through the repository, the way the app does.
    repo.saveTokens(ctx.db, {
      accessToken: 'at-secret-value',
      refreshToken: 'rt-secret-value',
      expiryMs: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      accountEmail: 'demo@local.test',
    });
    const res = await request(app).get('/api/auth/status').expect(200);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('rt-secret-value');
    expect(serialised).not.toContain('at-secret-value');
  });
});

describe('GET /api/auth/google', () => {
  it('returns a 503 with setup instructions when unconfigured', async () => {
    const res = await request(app).get('/api/auth/google').expect(503);
    expect(res.body.error.code).toBe('not_configured');
    expect(res.body.error.hint).toContain('README');
  });
});

describe('POST /api/auth/disconnect', () => {
  it('is safe to call when nothing is connected', async () => {
    const res = await request(app).post('/api/auth/disconnect').expect(200);
    expect(res.body.connected).toBe(false);
  });
});

describe('POST /api/analyze', () => {
  it('rejects a real-mail run when Gmail is not configured', async () => {
    const res = await request(app).post('/api/analyze').send({}).expect(503);
    expect(res.body.error.code).toBe('not_configured');
  });

  it('runs the demo analysis and returns items', async () => {
    const res = await request(app).post('/api/analyze').send({ demo: true }).expect(200);

    expect(res.body.run.fetched).toBeGreaterThan(5);
    expect(res.body.run.skippedNoise).toBeGreaterThan(2);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.length).toBeLessThan(8);
  });

  it('returns items with every field the UI renders', async () => {
    const res = await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const item = res.body.items[0];

    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('priority');
    expect(item).toHaveProperty('category');
    expect(item.title.length).toBeGreaterThan(0);
    expect(item.whyItMatters.length).toBeGreaterThan(0);
    expect(item.recommendedAction.length).toBeGreaterThan(0);
    expect(item).toHaveProperty('deadline');
    expect(item.confidence).toBeGreaterThan(0);
    expect(item.gmailUrl).toContain('mail.google.com');
    expect(item.source.sender.length).toBeGreaterThan(0);
    expect(item.createdAt).toBeTruthy();
  });

  it('does not return full email bodies', async () => {
    const res = await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    for (const item of res.body.items) {
      expect(item.source.excerpt.length).toBeLessThanOrEqual(700);
    }
  });

  it('is idempotent: a second run creates no duplicate items', async () => {
    const first = await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const second = await request(app).post('/api/analyze').send({ demo: true }).expect(200);

    expect(second.body.run.newItems).toBe(0);
    expect(second.body.items.length).toBe(first.body.items.length);
  });

  it('clamps an absurd limit', async () => {
    const res = await request(app).post('/api/analyze').send({ demo: true, limit: 99999 }).expect(200);
    expect(res.body.run.fetched).toBeLessThanOrEqual(500);
  });
});

describe('GET /api/attention', () => {
  it('is empty before any analysis', async () => {
    const res = await request(app).get('/api/attention').expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.counts.open).toBe(0);
  });

  it('returns open items after analysis', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).get('/api/attention').expect(200);

    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.counts.open).toBe(res.body.items.length);
  });

  it('honours the status filter', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const all = await request(app).get('/api/attention?status=all').expect(200);
    expect(all.body.items.length).toBeGreaterThan(0);
  });

  it('ignores an unknown status rather than erroring', async () => {
    const res = await request(app).get('/api/attention?status=bogus').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe('item lifecycle', () => {
  async function firstItemId(): Promise<string> {
    return (await allItemIds())[0];
  }

  async function allItemIds(): Promise<string[]> {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).get('/api/attention').expect(200);
    return (res.body.items as { id: string }[]).map((i) => i.id);
  }

  it('marks an item handled and removes it from the open feed', async () => {
    const id = await firstItemId();
    await request(app).post(`/api/attention/${id}/handled`).expect(200);

    const open = await request(app).get('/api/attention').expect(200);
    expect(open.body.items.find((i: { id: string }) => i.id === id)).toBeUndefined();
    expect(open.body.counts.handled).toBe(1);
  });

  it('counts every decided item, not just the first', async () => {
    const ids = await allItemIds();
    expect(ids.length).toBeGreaterThanOrEqual(2);

    await request(app).post(`/api/attention/${ids[0]}/handled`).expect(200);
    await request(app).post(`/api/attention/${ids[1]}/handled`).expect(200);
    await request(app).post(`/api/attention/${ids[2]}/dismiss`).expect(200);

    const feed = await request(app).get('/api/attention').expect(200);
    // A count taken from a limited list saturates at 1 and cannot tell "one"
    // from "more than one", so this asserts the actual totals.
    expect(feed.body.counts.handled).toBe(2);
    expect(feed.body.counts.dismissed).toBe(1);
  });

  it('dismisses an item', async () => {
    const id = await firstItemId();
    await request(app).post(`/api/attention/${id}/dismiss`).expect(200);

    const all = await request(app).get('/api/attention?status=all').expect(200);
    expect(all.body.items.find((i: { id: string }) => i.id === id).status).toBe('dismissed');
  });

  it('reopens an item', async () => {
    const id = await firstItemId();
    await request(app).post(`/api/attention/${id}/dismiss`).expect(200);
    const res = await request(app).post(`/api/attention/${id}/reopen`).expect(200);
    expect(res.body.item.status).toBe('open');
  });

  it('returns 404 for an unknown item', async () => {
    const res = await request(app).post('/api/attention/does-not-exist/handled').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns the item detail with its history', async () => {
    const id = await firstItemId();
    const res = await request(app).get(`/api/attention/${id}`).expect(200);
    expect(res.body.item.id).toBe(id);
    expect(res.body.history.length).toBeGreaterThan(0);
  });

  it('returns the source email as plain text', async () => {
    const id = await firstItemId();
    const res = await request(app).get(`/api/attention/${id}/source`).expect(200);

    expect(res.body.available).toBe(true);
    expect(typeof res.body.excerpt).toBe('string');
    expect(res.body.excerpt).not.toContain('<script');
    expect(res.body.excerpt).not.toContain('<p>');
  });
});

describe('POST /api/ask', () => {
  it('answers what needs attention', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).post('/api/ask').send({ question: 'What needs my attention?' }).expect(200);

    expect(res.body.outOfScope).toBe(false);
    expect(res.body.answer.length).toBeGreaterThan(10);
    expect(res.body.citedItemIds.length).toBeGreaterThan(0);
  });

  it('identifies the most urgent item', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).post('/api/ask').send({ question: 'What is the most urgent thing?' }).expect(200);
    expect(res.body.citedItemIds.length).toBe(1);
    expect(res.body.answer).toContain('most urgent');
  });

  it('explains why an item matters', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).post('/api/ask').send({ question: 'Why is this important?' }).expect(200);
    expect(res.body.answer.length).toBeGreaterThan(10);
  });

  it('says the action to take', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).post('/api/ask').send({ question: 'What do I need to do?' }).expect(200);
    expect(res.body.answer.length).toBeGreaterThan(5);
  });

  it('points at the source email', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).post('/api/ask').send({ question: 'Show me the email this came from.' }).expect(200);
    expect(res.body.answer).toContain('Subject:');
  });

  it('lists deadlines', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).post('/api/ask').send({ question: 'When are my deadlines?' }).expect(200);
    expect(res.body.outOfScope).toBe(false);
  });

  it('refuses an out-of-scope question', async () => {
    const res = await request(app).post('/api/ask').send({ question: 'Write me a Python function to sort a list' }).expect(200);
    expect(res.body.outOfScope).toBe(true);
    expect(res.body.answer).toContain('attention items');
  });

  it('rejects an empty question', async () => {
    const res = await request(app).post('/api/ask').send({ question: '   ' }).expect(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('rejects an overlong question', async () => {
    const res = await request(app).post('/api/ask').send({ question: 'x'.repeat(600) }).expect(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('reports honestly when nothing needs attention', async () => {
    const res = await request(app).post('/api/ask').send({ question: 'What needs my attention?' }).expect(200);
    expect(res.body.answer.toLowerCase()).toContain('nothing');
  });
});

describe('security behaviour', () => {
  it('sets security headers', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('returns a structured 404 for an unknown API route', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns a structured 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/ask')
      .set('Content-Type', 'application/json')
      .send('{not json')
      .expect(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('rate limits repeated analysis requests', async () => {
    let limited = false;
    for (let i = 0; i < 14; i++) {
      const res = await request(app).post('/api/analyze').send({ demo: true });
      if (res.status === 429) {
        limited = true;
        expect(res.body.error.code).toBe('rate_limited');
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it('never returns a stack trace', async () => {
    const res = await request(app).post('/api/attention/%00/handled').expect(404);
    expect(JSON.stringify(res.body)).not.toContain('at Object');
    expect(JSON.stringify(res.body)).not.toContain('.ts:');
  });
});

describe('GET /api/debug/suppressed', () => {
  it('is empty before a run', async () => {
    const res = await request(app).get('/api/debug/suppressed').expect(200);
    expect(res.body.run).toBeNull();
  });

  it('returns the run summary', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).get('/api/debug/suppressed').expect(200);
    expect(res.body.run.fetched).toBeGreaterThan(0);
    expect(res.body.run.finishedAt).toBeTruthy();
  });

  it('explains each suppressed message, not just the totals', async () => {
    await request(app).post('/api/analyze').send({ demo: true }).expect(200);
    const res = await request(app).get('/api/debug/suppressed').expect(200);

    // The audit trail has to be answerable per message: a run that suppressed
    // the newsletter and the expired deadline must say which was which.
    expect(res.body.suppressed.length).toBeGreaterThan(0);
    for (const row of res.body.suppressed as Record<string, unknown>[]) {
      expect(typeof row.suppression).toBe('string');
      expect(String(row.suppression).length).toBeGreaterThan(0);
      expect(typeof row.subject).toBe('string');
    }
    expect(
      (res.body.suppressed as { suppression: string }[]).some((r) =>
        r.suppression.includes('noise'),
      ),
    ).toBe(true);
  });
});

describe('engine integration', () => {
  it('suppresses resolved threads so they never reach the feed', async () => {
    // Feed the engine the resolved-request fixture directly, bypassing HTTP.
    const provider = new FixtureProvider();
    const messages = (await provider.fetchThread('fx-resolved-001')).map((m) =>
      toNormalizedEmail({
        id: m.id,
        threadId: m.threadId,
        internalDateMs: m.internalDateMs,
        snippet: m.snippet,
        labelIds: m.labelIds,
        raw: m.raw,
      }),
    );

    const result = await new AttentionEngine({
      aiProvider: new HeuristicProvider(),
      clock: fixedClock('2026-09-29T12:00:00.000Z'),
      minConfidence: 0.55,
      aiMode: 'off',
    }).analyze({ messages });

    expect(result.items).toHaveLength(0);
    expect(result.suppressed.some((s) => s.reason === 'resolved_in_thread')).toBe(true);
  });

  it('emits notifications only for items that pass every rule', () => {
    const notifications = new EmitterNotificationService();
    const base = {
      id: 'i1',
      eventKey: 'k',
      threadId: null,
      sourceMessageId: 'm',
      sourceThreadId: null,
      category: 'verification' as const,
      priority: 'high' as const,
      confidence: 0.9,
      title: 't',
      summary: '',
      whyItMatters: '',
      recommendedAction: '',
      deadlineIso: null,
      deadlineRaw: null,
      status: 'open' as const,
      resolvedReason: null,
      decidedBy: 'rules',
      createdAt: '',
      updatedAt: '',
      notifiedAt: null,
    };

    expect(notifications.shouldNotify(base, 'high', 0.55)).toBe(true);
    expect(notifications.shouldNotify({ ...base, priority: 'medium' }, 'high', 0.55)).toBe(false);
    expect(notifications.shouldNotify({ ...base, priority: 'medium' }, 'all', 0.55)).toBe(true);
    expect(notifications.shouldNotify(base, 'off', 0.55)).toBe(false);
    expect(notifications.shouldNotify({ ...base, status: 'handled' }, 'all', 0.55)).toBe(false);
    expect(notifications.shouldNotify({ ...base, notifiedAt: '2026-09-29T12:00:00.000Z' }, 'all', 0.55)).toBe(false);
    expect(notifications.shouldNotify({ ...base, confidence: 0.2 }, 'all', 0.55)).toBe(false);
  });

  it('never notifies the same item twice', () => {
    const notifications = new EmitterNotificationService();
    const seen: string[] = [];
    notifications.onNotification((p) => seen.push(p.itemId));

    const payload = {
      itemId: 'i1',
      title: 't',
      body: 'b',
      priority: 'high',
      category: 'verification',
      deadlineIso: null,
      gmailUrl: 'https://mail.google.com/mail/u/0/#all/m',
    };

    notifications.notify(payload);
    notifications.notify(payload);
    expect(seen).toEqual(['i1']);
  });

  it('survives a sink that throws', () => {
    const notifications = new EmitterNotificationService([
      () => {
        throw new Error('sink failure');
      },
    ]);
    expect(() =>
      notifications.notify({
        itemId: 'i1',
        title: 't',
        body: 'b',
        priority: 'high',
        category: 'verification',
        deadlineIso: null,
        gmailUrl: 'https://mail.google.com/mail/u/0/#all/m',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Deadline extraction, focused here because dates drive priority.
// ---------------------------------------------------------------------------

const ANCHOR = new Date('2026-09-29T09:00:00.000Z');

describe('deadline extraction', () => {
  it('extracts an explicit ISO date', () => {
    const { deadline } = extractDeadline('The deadline is 2026-10-05 for this request.', ANCHOR);
    expect(deadline.iso).toBeTruthy();
    expect(deadline.kind).toBe('explicit');
    expect(new Date(deadline.iso as string).getUTCDate()).toBe(5);
  });

  it('extracts "within 72 hours" as a future date', () => {
    const { deadline } = extractDeadline('Please complete this within 72 hours.', ANCHOR);
    expect(deadline.iso).toBeTruthy();
    expect(daysUntil(deadline.iso as string, ANCHOR)).toBe(3);
    expect(deadline.kind).toBe('relative');
  });

  it('extracts "within 14 days"', () => {
    const { deadline } = extractDeadline('Reply within 14 days.', ANCHOR);
    expect(daysUntil(deadline.iso as string, ANCHOR)).toBe(14);
  });

  it('extracts "expires in 30 days" as an expiry', () => {
    const { deadline } = extractDeadline('Your trial expires in 30 days.', ANCHOR);
    expect(deadline.kind).toBe('expiry');
    expect(daysUntil(deadline.iso as string, ANCHOR)).toBe(30);
  });

  it('extracts a written date', () => {
    const { deadline } = extractDeadline('The submission is due on 15 October 2026.', ANCHOR);
    expect(deadline.iso).toBeTruthy();
    expect(new Date(deadline.iso as string).getUTCMonth()).toBe(9);
  });

  it('extracts a weekday deadline and resolves it into the future', () => {
    const { deadline } = extractDeadline('Please reply by Friday.', ANCHOR);
    expect(deadline.iso).toBeTruthy();
    expect(isDeadlinePassed(deadline.iso as string, ANCHOR)).toBe(false);
  });

  it('extracts named durations', () => {
    const { deadline } = extractDeadline('You must respond in two weeks.', ANCHOR);
    expect(daysUntil(deadline.iso as string, ANCHOR)).toBe(14);
  });

  it('returns no deadline for ambiguous language rather than guessing', () => {
    const { deadline, vagueDeadlineLanguage } = extractDeadline(
      'Please respond as soon as possible.',
      ANCHOR,
    );
    expect(deadline.iso).toBeNull();
    expect(vagueDeadlineLanguage).toBe(true);
  });

  it('returns no deadline when there is no date at all', () => {
    const { deadline } = extractDeadline('Hello, just checking in.', ANCHOR);
    expect(deadline.iso).toBeNull();
    expect(deadline.raw).toBeNull();
  });

  it('prefers a duration over an unrelated event timestamp', () => {
    // The security-alert shape: a "When:" record timestamp plus "within 24 hours".
    const text = [
      'When: 28 September 2026 at 22:38',
      'If you do not reset your password within 24 hours, we will lock your account.',
    ].join('\n');
    const { deadline } = extractDeadline(text, ANCHOR);
    expect(deadline.raw).toContain('24 hours');
    expect(daysUntil(deadline.iso as string, ANCHOR)).toBe(1);
  });

  it('does not treat a bare date with no deadline language as a deadline', () => {
    const { deadline } = extractDeadline('Sent on 28 September 2026 by the system.', ANCHOR);
    expect(deadline.iso).toBeNull();
  });

  it('reports a passed deadline as passed', () => {
    expect(isDeadlinePassed('2026-09-01T00:00:00.000Z', ANCHOR)).toBe(true);
    expect(isDeadlinePassed('2026-10-01T00:00:00.000Z', ANCHOR)).toBe(false);
    expect(isDeadlinePassed('not-a-date', ANCHOR)).toBe(false);
  });

  it('formats a deadline for display', () => {
    expect(formatDeadlineForDisplay('2026-10-05T09:00:00.000Z').length).toBeGreaterThan(5);
    expect(formatDeadlineForDisplay('nonsense')).toBe('nonsense');
  });

  it('skips weekends for a business-day duration', () => {
    // Anchor is a Tuesday, so 3 business days lands on the following Friday.
    const { deadline } = extractDeadline('Please respond within 3 business days.', ANCHOR);
    expect(new Date(deadline.iso as string).getDay()).not.toBe(0);
    expect(new Date(deadline.iso as string).getDay()).not.toBe(6);
    expect(daysUntil(deadline.iso as string, ANCHOR)).toBeGreaterThanOrEqual(3);
  });
});
