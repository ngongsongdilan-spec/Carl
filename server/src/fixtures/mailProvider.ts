import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MailAccount, MailProvider, RawMessage } from '../mail/provider.js';
import { toNormalizedEmail } from '../mail/normalize.js';
import type { NormalizedEmail } from '../domain/types.js';
import { expandDateTokens, formatLongDate, formatRfcDate } from './dates.js';

/**
 * A MailProvider backed by a local JSON file.
 *
 * This is what makes the attention engine testable and demonstrable without a
 * Gmail account. It is a first-class implementation of the same interface the
 * real service implements, so the demo path exercises every line of engine code
 * that the Gmail path does.
 *
 * It is NOT a stub: the fixtures are real RFC822 messages and the normalisation
 * is the production code path.
 */

export interface FixtureMessageFile {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  raw: string;
}

export interface FixtureFile {
  description?: string;
  expected?: {
    isAttentionItem: boolean;
    category?: string;
    priority?: string;
    reason?: string;
  };
  /**
   * Demo-only override: how many days back the fixture's newest message should
   * land when the demo shifts fixtures to "now".
   *
   * The default of 1 day keeps a relative deadline like "within 24 hours"
   * comfortably inside its window. A fixture overrides this when the shift would
   * change what the scenario is demonstrating -- most importantly one that is
   * *about* an expired deadline, which must stay expired in the demo.
   */
  demoAgeDays?: number;
  messages: FixtureMessageFile[];
}

/** The earliest message timestamp in a fixture, used as its date-token anchor. */
function anchorOf(file: FixtureFile): Date {
  const times = file.messages.map((m) => new Date(m.internalDate).getTime());
  return new Date(Math.min(...times));
}

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveFixturesDir(): string {
  const candidates = [
    path.join(here, '..', '..', '..', 'tests', 'fixtures', 'mail'),
    path.join(process.cwd(), 'server', 'tests', 'fixtures', 'mail'),
    path.join(process.cwd(), 'tests', 'fixtures', 'mail'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[1];
}

export function listFixtureFiles(dir = resolveFixturesDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort();
}

/**
 * Reads a fixture file with its date tokens expanded against its own anchor, so
 * callers always see concrete dates. The shift is applied here too when the
 * caller wants the demo's relative-to-now behaviour.
 */
export function loadFixtureFile(
  name: string,
  dir = resolveFixturesDir(),
  shiftMs = 0,
): FixtureFile {
  const file = path.join(dir, name.endsWith('.json') ? name : `${name}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureFile;
  const anchor = new Date(anchorOf(parsed).getTime() + shiftMs);

  return {
    ...parsed,
    messages: parsed.messages.map((m) => ({
      ...m,
      internalDate: new Date(new Date(m.internalDate).getTime() + shiftMs).toISOString(),
      raw: expandDateTokens(m.raw, { anchor }).replace(
        /^Date: .*$/m,
        `Date: ${formatRfcDate(new Date(new Date(m.internalDate).getTime() + shiftMs))}`,
      ),
    })),
  };
}

export function loadAllFixtures(
  dir = resolveFixturesDir(),
): { files: { name: string; data: FixtureFile }[] } {
  return {
    files: listFixtureFiles(dir).map((name) => ({
      name,
      data: loadFixtureFile(name, dir),
    })),
  };
}

/**
 * How many days back a demo fixture's newest message lands when the fixture does
 * not say otherwise.
 *
 * Half a day, not a whole day: a relative deadline is measured from the message
 * ("within 24 hours"), so landing the message exactly 24 hours ago puts the
 * deadline on the boundary where it counts as already expired. Twelve hours in
 * leaves the highest-signal scenario in the demo live.
 */
const DEFAULT_DEMO_AGE_DAYS = 0.5;

/** All fixture messages merged into one flat list, as a single inbox would be. */
/**
 * Loads every fixture message as one flat inbox.
 *
 * `relativeToNow` shifts the whole corpus so that the newest message lands
 * `daysBack` days before today. The demo needs this: fixtures are pinned to a
 * fixed date so the tests are deterministic, but that same pin means their
 * deadlines expire as time passes, and a demo where everything is silently
 * suppressed is useless. Tests call this without the option and get the fixed
 * dates.
 */
export function loadFixtureMessages(
  dir = resolveFixturesDir(),
  relativeToNow = false,
): RawMessage[] {
  const files = listFixtureFiles(dir);

  const all: RawMessage[] = [];

  for (const name of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as FixtureFile;

    // Each fixture is shifted independently so that its newest message lands
    // shortly before now. A single global shift would age the older fixtures
    // forward relative to their own deadlines, which correctly suppresses them
    // as expired and leaves the demo looking empty. Per-fixture keeps every
    // scenario live while preserving the spacing inside each one.
    //
    // `demoAgeDays` is how far back a fixture wants to sit. The default keeps a
    // "within 24 hours" deadline inside its window; a fixture that exists to
    // demonstrate an *expired* deadline overrides it so the demo still shows
    // that scenario being filtered rather than silently resurfacing it.
    let shift = 0;
    if (relativeToNow && parsed.messages.length > 0) {
      const newest = Math.max(
        ...parsed.messages.map((m) => new Date(m.internalDate).getTime()),
      );
      const ageDays = parsed.demoAgeDays ?? DEFAULT_DEMO_AGE_DAYS;
      shift = Date.now() - ageDays * 24 * 60 * 60 * 1000 - newest;
    }

    for (const m of loadFixtureFile(name, dir, shift).messages) {
      all.push({
        id: m.id,
        threadId: m.threadId,
        internalDateMs: new Date(m.internalDate).getTime(),
        snippet: '',
        labelIds: m.labelIds,
        raw: m.raw,
      });
    }
  }

  // A single flat inbox: newest first, matching what a real provider returns.
  all.sort((a, b) => (b.internalDateMs ?? 0) - (a.internalDateMs ?? 0));

  return all;
}

export class FixtureProvider implements MailProvider {
  private readonly dir: string;
  private readonly relativeToNow: boolean;

  /**
   * `relativeToNow` is set by the demo path so fixture deadlines stay live; the
   * tests leave it off so dates remain fixed.
   */
  constructor(dir = resolveFixturesDir(), relativeToNow = false) {
    this.dir = dir;
    this.relativeToNow = relativeToNow;
  }

  isConfigured(): boolean {
    return true;
  }

  getAccount(): MailAccount {
    return { email: 'demo@local.test', scopes: ['fixture'] };
  }

  getAuthorizationUrl(): string {
    throw new Error('The fixture provider does not use OAuth.');
  }

  async exchangeCode(): Promise<MailAccount> {
    return this.getAccount();
  }

  async fetchRecentMessages(limit: number): Promise<RawMessage[]> {
    return loadFixtureMessages(this.dir, this.relativeToNow).slice(0, limit);
  }

  async fetchThread(threadId: string): Promise<RawMessage[]> {
    return loadFixtureMessages(this.dir, this.relativeToNow)
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => (a.internalDateMs ?? 0) - (b.internalDateMs ?? 0));
  }

  getMessageUrl(messageId: string): string {
    return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`;
  }

  disconnect(): void {
    // nothing to do
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
