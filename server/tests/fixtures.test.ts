import { describe, expect, it } from 'vitest';
import { AttentionEngine } from '../src/attention/engine.js';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import { fixedClock, systemClock } from '../src/util/clock.js';
import {
  loadAllFixtures,
  loadFixtureFile,
  FixtureProvider,
} from '../src/fixtures/mailProvider.js';
import type { NormalizedEmail } from '../src/domain/types.js';

/**
 * Fixture-driven end-to-end tests for the attention engine.
 *
 * These are the tests that matter most: they assert what the product actually
 * promises, using real RFC822 messages parsed by the production parser.
 *
 * All fixtures are dated September 2026, and the clock is pinned just after them,
 * so deadline arithmetic is deterministic.
 */

const NOW = '2026-09-29T12:00:00.000Z';
const provider = new FixtureProvider();

function engine(overrides: Partial<ConstructorParameters<typeof AttentionEngine>[0]> = {}) {
  return new AttentionEngine({
    aiProvider: new HeuristicProvider('test'),
    clock: fixedClock(NOW),
    minConfidence: 0.55,
    aiMode: 'off',
    ...overrides,
  });
}

function normalizeFixture(name: string): NormalizedEmail[] {
  const file = loadFixtureFile(name);
  return file.messages.map((m) =>
    provider.normalize({
      id: m.id,
      threadId: m.threadId,
      internalDateMs: new Date(m.internalDate).getTime(),
      snippet: '',
      labelIds: m.labelIds,
      raw: m.raw,
    }),
  );
}

/** Runs the engine over one fixture file and returns the result. */
async function analyzeFixture(name: string, overrides = {}) {
  const messages = normalizeFixture(name);
  const result = await engine(overrides).analyze({ messages });
  return { result, messages };
}

describe('fixture inventory', () => {
  it('ships the twelve required scenarios', () => {
    const { files } = loadAllFixtures();
    const names = files.map((f) => f.name);
    expect(names.length).toBeGreaterThanOrEqual(12);
    expect(names.some((n) => n.includes('newsletter'))).toBe(true);
    expect(names.some((n) => n.includes('advertisement'))).toBe(true);
    expect(names.some((n) => n.includes('receipt'))).toBe(true);
    expect(names.some((n) => n.includes('security'))).toBe(true);
    expect(names.some((n) => n.includes('verification'))).toBe(true);
    expect(names.some((n) => n.includes('university'))).toBe(true);
    expect(names.some((n) => n.includes('meeting'))).toBe(true);
    expect(names.some((n) => n.includes('resolved'))).toBe(true);
    expect(names.some((n) => n.includes('passed-deadline'))).toBe(true);
    expect(names.some((n) => n.includes('thread-reschedule'))).toBe(true);
    expect(names.some((n) => n.includes('announcement'))).toBe(true);
  });

  it('every fixture carries an expectation block for documentation', () => {
    for (const { data } of loadAllFixtures().files) {
      expect(data.expected, 'missing expected block').toBeDefined();
      expect((data.description ?? '').length).toBeGreaterThan(10);
    }
  });
});

describe('important emails produce attention items', () => {
  it('raises an item for a domain verification request', async () => {
    const { result } = await analyzeFixture('04-domain-verification.json');

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.category).toBe('verification');
    expect(item.priority).toBe('high');
    expect(item.title.length).toBeGreaterThan(5);
    expect(item.summary.length).toBeGreaterThan(10);
    expect(item.whyItMatters.length).toBeGreaterThan(10);
    expect(item.recommendedAction.length).toBeGreaterThan(10);
    expect(item.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('extracts the deadline as a concrete future date', async () => {
    const { result } = await analyzeFixture('04-domain-verification.json');
    const item = result.items[0];

    expect(item.deadline.iso).not.toBeNull();
    expect(item.deadline.raw).toContain('7 days');
    const resolved = new Date(item.deadline.iso as string);
    expect(resolved.getTime()).toBeGreaterThan(Date.parse(NOW));
    expect(item.deadline.confidence).toBeGreaterThan(0);
  });

  it('produces a recommended action that reads as a complete instruction', async () => {
    // Guards against the failure mode where a lifted phrase is cut mid-word and
    // the user is told to "pay the outstanding amount within 7".
    const { files } = loadAllFixtures();
    const allMessages: NormalizedEmail[] = [];
    for (const { name } of files) allMessages.push(...normalizeFixture(name));

    const result = await engine().analyze({ messages: allMessages });

    for (const item of result.items) {
      const action = item.recommendedAction.trim();
      expect(action.length).toBeGreaterThan(10);
      expect(action).toMatch(/[.!?]$/);
      // No dangling preposition, which is the tell-tale of a mid-clause cut.
      expect(action).not.toMatch(/\b(?:for|to|that|which|and|or|with|in|on|at|by|from)$/i);
      // No sentence cut in the middle of a number.
      expect(action).not.toMatch(/\b\d+$/);
    }
  });

  it('raises a high-priority item for a university deadline', async () => {
    const { result } = await analyzeFixture('05-university-deadline.json');
    const item = result.items[0];

    expect(item.category).toBe('requirement');
    expect(item.priority).toBe('high');
    expect(item.deadline.iso).not.toBeNull();
  });

  it('raises a high-priority item for a failed payment', async () => {
    const { result } = await analyzeFixture('12-payment-failed.json');
    const item = result.items[0];

    expect(item.category).toBe('payment_action');
    expect(item.priority).toBe('high');
    expect(item.summary).toContain('$');
  });

  it('raises a high-priority item for a security alert', async () => {
    const { result } = await analyzeFixture('07-password-security-alert.json');
    const item = result.items[0];

    expect(item.category).toBe('account_security');
    expect(item.priority).toBe('high');
    expect(item.whyItMatters.length).toBeGreaterThan(15);
  });

  it('raises an item for a meeting request', async () => {
    const { result } = await analyzeFixture('06-meeting-request.json');
    expect(result.items).toHaveLength(1);
    expect(['requested_response', 'appointment']).toContain(result.items[0].category);
  });
});

describe('ordinary emails produce nothing', () => {
  it.each([
    ['01-newsletter.json', 'newsletter'],
    ['02-advertisement.json', 'advertisement'],
    ['03-receipt.json', 'receipt'],
    ['11-informational-announcement.json', 'informational'],
  ])('does not raise an item for %s', async (file, expectedCategory) => {
    const { result } = await analyzeFixture(file);

    expect(result.items).toHaveLength(0);
    expect(result.suppressed.length).toBeGreaterThan(0);
    const reasons = result.suppressed.map((s) => s.reason);
    expect(reasons).toContain('noise');

    const suppressed = result.suppressed.find((s) => s.reason === 'noise');
    expect(suppressed?.category).toBe(expectedCategory);
  });
});

describe('thread context', () => {
  it('does not raise an item for a request that was resolved in the thread', async () => {
    const { result } = await analyzeFixture('08-resolved-request.json');

    expect(result.items).toHaveLength(0);
    const suppressed = result.suppressed.find((s) => s.reason === 'resolved_in_thread');
    expect(suppressed).toBeDefined();
    expect(suppressed?.detail.toLowerCase()).toContain('resolved');
  });

  it('anchors the item on the newest message when a thread changes situation', async () => {
    const { result } = await analyzeFixture('10-thread-reschedule.json');

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    // The item must come from the reschedule message, not the original booking.
    expect(item.sourceMessageId).toBe('fx-thread-002');
    expect(item.summary.toLowerCase()).toContain('rescheduled');
    expect(item.deadline.iso).not.toBeNull();
  });
});

describe('expired deadlines', () => {
  it('suppresses an item whose deadline has already passed', async () => {
    const { result } = await analyzeFixture('09-passed-deadline.json');

    expect(result.items).toHaveLength(0);
    const suppressed = result.suppressed.find((s) => s.reason === 'deadline_passed');
    expect(suppressed).toBeDefined();
  });

  it('still raises the same item when the deadline is in the future', async () => {
    // Same email, clock moved back before the 10 September deadline.
    const messages = normalizeFixture('09-passed-deadline.json');
    const result = await engine({
      clock: fixedClock('2026-09-01T00:00:00.000Z'),
    }).analyze({ messages });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].deadline.iso).not.toBeNull();
  });
});

/**
 * The demo shifts fixtures to "now" so they do not all age out. That shift is a
 * real behaviour with its own failure mode: a fixture shifted too far forward
 * loses the very condition it exists to demonstrate. These tests run the demo
 * corpus through the engine with the real clock and assert both directions.
 */
describe('demo date shifting', () => {
  const demoProvider = new FixtureProvider(undefined, true);

  async function analyzeDemoInbox() {
    const raw = await demoProvider.fetchRecentMessages(100);
    const messages = raw.map((m) => demoProvider.normalize(m));
    // The real clock: this is what the demo sees.
    const result = await new AttentionEngine({
      aiProvider: new HeuristicProvider('test'),
      clock: systemClock,
      minConfidence: 0.55,
      aiMode: 'off',
    }).analyze({ messages });
    return { result, messages };
  }

  it('keeps the security alert in the demo feed', async () => {
    const { result } = await analyzeDemoInbox();

    const security = result.items.find((i) => i.category === 'account_security');
    expect(security, 'the highest-signal scenario must appear in the demo').toBeDefined();
    expect(security?.deadline.iso).not.toBeNull();
  });

  it('keeps the expired deadline suppressed in the demo', async () => {
    const { result } = await analyzeDemoInbox();

    // The opposite requirement: this fixture demonstrates the engine *not*
    // raising something, and shifting it live would quietly delete the
    // scenario from the demo.
    expect(result.items.some((i) => i.title.toLowerCase().includes('parking'))).toBe(false);
    expect(result.suppressed.some((s) => s.reason === 'deadline_passed')).toBe(true);
  });

  it('surfaces a small, actionable number of items', async () => {
    const { result } = await analyzeDemoInbox();

    expect(result.items.length).toBeGreaterThanOrEqual(4);
    expect(result.items.length).toBeLessThanOrEqual(7);
    // Nothing informational or noise-category survives into the feed.
    expect(result.items.some((i) => i.category === 'informational')).toBe(false);
  });

  it('honours a fixture that pins its own demo age', () => {
    const pinned = loadFixtureFile('09-passed-deadline.json', undefined, 0);
    expect(pinned.demoAgeDays).toBeGreaterThan(1);
  });
});

describe('the anti-slop guarantee', () => {
  it('does not treat a mostly-noise inbox as important', async () => {
    const { files } = loadAllFixtures();
    const allMessages: NormalizedEmail[] = [];
    for (const { name } of files) allMessages.push(...normalizeFixture(name));

    const result = await engine().analyze({ messages: allMessages });

    // 12 fixtures: 6 are designed to be actionable, 6 are not.
    // The engine may legitimately miss one, but it must not flag the noise.
    expect(result.items.length).toBeGreaterThanOrEqual(4);
    expect(result.items.length).toBeLessThanOrEqual(7);
    expect(result.stats.prefilteredNoise).toBeGreaterThanOrEqual(4);
  });

  it('never raises an item whose category is non-actionable', async () => {
    const { files } = loadAllFixtures();
    const allMessages: NormalizedEmail[] = [];
    for (const { name } of files) allMessages.push(...normalizeFixture(name));

    const result = await engine().analyze({ messages: allMessages });
    const actionable = new Set([
      'deadline',
      'account_security',
      'verification',
      'payment_action',
      'appointment',
      'requirement',
      'requested_response',
      'personal',
      'service_interruption',
      'expiring_item',
      'delivery_action',
      'administrative',
    ]);

    for (const item of result.items) {
      expect(actionable.has(item.category)).toBe(true);
    }
  });

  it('every raised item explains why it matters and what to do', async () => {
    const { files } = loadAllFixtures();
    const allMessages: NormalizedEmail[] = [];
    for (const { name } of files) allMessages.push(...normalizeFixture(name));

    const result = await engine().analyze({ messages: allMessages });

    for (const item of result.items) {
      expect(item.whyItMatters.trim().length).toBeGreaterThan(15);
      expect(item.recommendedAction.trim().length).toBeGreaterThan(10);
      expect(item.title.trim().length).toBeGreaterThan(5);
      expect(item.confidence).toBeGreaterThanOrEqual(0.55);
      expect(item.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('reports progress through every stage', async () => {
    const messages = normalizeFixture('04-domain-verification.json');
    const stages: string[] = [];
    await engine({
      onProgress: (p) => stages.push(p.stage),
    }).analyze({ messages });

    expect(stages).toContain('rules');
    expect(stages[stages.length - 1]).toBe('done');
  });

  it('handles an empty inbox without throwing', async () => {
    const result = await engine().analyze({ messages: [] });
    expect(result.items).toHaveLength(0);
    expect(result.stats.total).toBe(0);
  });

  it('explains a suppression with whole words, not a mid-word cut', async () => {
    const { result } = await analyzeFixture('08-resolved-request.json');
    const entry = result.suppressed.find((s) => s.reason === 'resolved_in_thread');
    expect(entry).toBeDefined();

    // The explanation is read by the user. A window that starts or ends inside a
    // word ("firmation. ...", "...is comp") is correct evidence but reads as
    // truncation damage.
    const quoted = entry!.detail.match(/"(.*)"$/s)?.[1] ?? '';
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted).not.toMatch(/^[a-z]+$|^\s/);
    // An ellipsis is the only permitted ending; a bare letter is not.
    if (quoted.length >= 100) expect(quoted.endsWith('…')).toBe(true);
  });

  it('handles a malformed message without throwing', async () => {
    const broken: NormalizedEmail = {
      id: 'broken-1',
      threadId: 'broken-1',
      subject: '',
      fromName: null,
      fromAddress: '',
      fromDomain: '',
      to: [],
      cc: [],
      snippet: '',
      bodyText: '',
      bodyWasHtml: false,
      date: new Date('2026-09-28T00:00:00.000Z'),
      labels: [],
      gmailCategory: null,
      listUnsubscribe: false,
      listId: null,
      precedence: null,
      messageIdHeader: null,
      inReplyTo: null,
      references: [],
    };

    const result = await engine().analyze({ messages: [broken] });
    expect(result.items).toHaveLength(0);
  });
});

describe('deduplication', () => {
  it('does not create a second item for an event already in the feed', async () => {
    const messages = normalizeFixture('04-domain-verification.json');
    const existing = [
      {
        eventKey: 'verification::example.com|registrar::1756512000000::fx-verify-001',
        category: 'verification',
        subject: 'Action required: verify registrant contact for example.com',
        createdAt: '2026-09-28T10:00:00.000Z',
        threadId: 'fx-verify-001',
      },
    ];

    const result = await engine().analyze({ messages, existingItems: existing });

    expect(result.items).toHaveLength(0);
    expect(result.suppressed.some((s) => s.reason === 'duplicate')).toBe(true);
  });

  it('collapses two identical messages inside a single run', async () => {
    const messages = normalizeFixture('04-domain-verification.json');
    const duplicated = [
      ...messages,
      // Same event, different message id but the same thread.
      { ...messages[0], id: 'fx-verify-001-copy' },
    ];

    const result = await engine().analyze({ messages: duplicated });
    expect(result.items).toHaveLength(1);
  });
});

describe('confidence behaviour', () => {
  it('assigns higher confidence to a security alert than to a bare question', async () => {
    const security = await analyzeFixture('07-password-security-alert.json');
    const meeting = await analyzeFixture('06-meeting-request.json');

    expect(security.result.items[0].confidence).toBeGreaterThan(
      meeting.result.items[0].confidence,
    );
  });

  it('never exceeds 1 or drops below the threshold in the feed', async () => {
    const { files } = loadAllFixtures();
    const allMessages: NormalizedEmail[] = [];
    for (const { name } of files) allMessages.push(...normalizeFixture(name));

    const result = await engine({ minConfidence: 0.6 }).analyze({ messages: allMessages });

    for (const item of result.items) {
      expect(item.confidence).toBeGreaterThanOrEqual(0.6);
      expect(item.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('filters out low-confidence candidates when the threshold is high', async () => {
    const strict = await engine({ minConfidence: 0.95 }).analyze({
      messages: normalizeFixture('06-meeting-request.json'),
    });
    expect(strict.items).toHaveLength(0);
    expect(strict.suppressed.some((s) => s.reason === 'low_confidence')).toBe(true);
  });
});
