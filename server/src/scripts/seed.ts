import { config } from '../config/env.js';
import { createContext } from '../index.js';
import * as repo from '../db/repositories.js';
import { setLogLevel } from '../logging/logger.js';
import { logger } from '../logging/logger.js';

/**
 * Seeds a local database from the demo fixtures and prints the resulting feed.
 *
 * Useful for inspecting what the attention engine decided without opening a
 * browser: it runs the real pipeline against real RFC822 messages and then
 * prints the items and, just as importantly, everything it suppressed and why.
 */

async function main(): Promise<void> {
  setLogLevel(process.env.LOG_LEVEL === 'debug' ? 'debug' : 'warn');

  const ctx = createContext(config);

  // Re-running is safe on its own: items are keyed by event, so the pipeline
  // finds the existing row and creates nothing. `--reset` exists for starting
  // over after changing a fixture or a rule, where the stale rows would
  // otherwise be kept and the output would mix old and new decisions.
  const reset = process.argv.includes('--reset');
  if (reset) {
    for (const item of repo.listItems(ctx.db, { statuses: ['open', 'handled', 'dismissed', 'resolved'], limit: 1000 })) {
      repo.deleteItem(ctx.db, item.id);
    }
    console.log('Cleared existing items (--reset).');
  } else {
    const existing = repo.countOpenItems(ctx.db);
    if (existing > 0) {
      logger.warn(
        `Database already has ${existing} open item(s). Re-running is safe: duplicates are suppressed.`,
      );
    }
  }

  const summary = await ctx.pipeline.run({ source: ctx.demoMessages ?? undefined });

  const items = repo.listItems(ctx.db, { statuses: ['open'], limit: 50 });

  console.log('');
  console.log('='.repeat(72));
  console.log('ATTENTION FEED');
  console.log('='.repeat(72));
  console.log(
    `fetched ${summary.fetched} · analysed ${summary.analysed} · ` +
      `filtered as noise ${summary.skippedNoise} · open items ${items.length}`,
  );
  console.log(`ai calls ${summary.aiCalls}${summary.degraded ? ' (degraded)' : ''}`);
  console.log('');

  for (const item of items) {
    console.log(`[${item.priority.toUpperCase()}] ${item.title}`);
    console.log(`  category   ${item.category}`);
    console.log(`  confidence ${item.confidence.toFixed(2)} (${item.decidedBy})`);
    console.log(`  deadline   ${item.deadlineRaw ?? 'none detected'}`);
    console.log(`  why        ${item.whyItMatters}`);
    console.log(`  action     ${item.recommendedAction}`);
    console.log(`  source     https://mail.google.com/mail/u/0/#all/${item.sourceMessageId}`);
    console.log('');
  }

  if (items.length === 0) {
    console.log('No important items right now.');
    console.log('');
  }

  if (summary.suppressed.length > 0) {
    console.log('-'.repeat(72));
    console.log(`SUPPRESSED (${summary.suppressed.length}) — what was deliberately not shown`);
    console.log('-'.repeat(72));
    for (const s of summary.suppressed) {
      console.log(`  ${s.reason.padEnd(18)} ${String(s.category).padEnd(20)} ${s.detail}`);
    }
    console.log('');
  }

  ctx.db.close();
}

main().catch((err: unknown) => {
  logger.error('Seed failed', { message: err instanceof Error ? err.message : 'unknown' });
  process.exit(1);
});
