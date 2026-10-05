import type { MailProvider, RawMessage } from '../mail/provider.js';
import { toNormalizedEmail } from '../mail/normalize.js';
import { AttentionEngine, type EngineItem, type SuppressedItem } from '../attention/engine.js';
import { prefilter } from '../attention/prefilter.js';
import type { AIProvider } from '../ai/provider.js';
import type { Database } from '../db/database.js';
import * as repo from '../db/repositories.js';
import { logger } from '../logging/logger.js';
import type { AppConfig } from '../config/env.js';
import type { Clock } from '../util/clock.js';
import { fromMailError } from '../util/errors.js';
import type { NotificationService } from '../notifications/service.js';
import { buildNotificationBody } from '../notifications/service.js';
import { randomUUID } from 'node:crypto';
import type { AttentionItem, NormalizedEmail } from '../domain/types.js';

/**
 * Orchestration: fetch -> normalize -> analyse -> persist -> notify.
 *
 * This is the only place that knows the order of operations. It holds no
 * decision logic of its own; those live in the engine.
 */

export interface RunOptions {
  limit?: number;
  onProgress?: (update: ProgressUpdate) => void;
  /** Overrides the configured provider. Used by the fixture demo path. */
  source?: RawMessage[] | null;
}

export type ProgressUpdate =
  | { stage: 'fetching'; fetched: number }
  | { stage: 'analysing'; processed: number; total: number }
  | { stage: 'persisting'; count: number }
  | { stage: 'done' };

export interface RunSummary {
  runId: string;
  fetched: number;
  analysed: number;
  skippedNoise: number;
  newItems: number;
  openItems: number;
  suppressed: SuppressedItem[];
  aiCalls: number;
  aiFailures: number;
  degraded: boolean;
  durationMs: number;
}

/**
 * A fetched thread with at least this many messages is taken as complete.
 *
 * A single-message thread still gets fetched: a one-message "thread" is exactly
 * the case where a sent reply is most likely to be missing, because the list
 * query excludes sent mail. The bound only avoids re-fetching threads that the
 * list query already returned in full.
 */
const FULL_THREAD_HINT = 8;

export interface PipelineDeps {
  config: AppConfig;
db: Database;
  clock: Clock;
  mail: MailProvider;
  /** Declared after mail/clock for readability; required by the engine stage. */
  ai: AIProvider;
  notifications: NotificationService;
}

export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(options: RunOptions = {}): Promise<RunSummary> {
    const { config, db, mail, ai, notifications, clock } = this.deps;
    const startedAt = clock.now();
    const runId = randomUUID();
    repo.startRun(db, runId);

    let fetched = 0;
    let aiCalls = 0;
    let aiFailures = 0;
    let degraded = false;

    try {
      // ---- 1. fetch ---------------------------------------------------
      let raw: RawMessage[];
      let threadsHydrated = false;
      if (options.source) {
        raw = options.source;
      } else {
        if (!mail.isConfigured()) {
          throw fromMailError({
            name: 'MailError',
            code: 'not_configured',
            message:
              'Gmail is not configured. Place credentials.json in the project root or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.',
            status: 503,
          });
        }
        if (!mail.getAccount()) {
          throw fromMailError({
            name: 'MailError',
            code: 'not_connected',
            message: 'No Gmail account is connected. Click "Connect Gmail" first.',
            status: 401,
          });
        }
        raw = await mail.fetchRecentMessages(options.limit ?? config.attention.messageLimit);
        // The list query excludes sent mail, so a reply the user already wrote
        // is invisible in `raw`. Without the rest of the thread the engine
        // cannot see that the conversation is resolved and will keep
        // resurfacing an item the user dealt with. Hydrating each thread costs
        // one API call per thread and is what makes resolution detection work.
        raw = await this.hydrateThreads(mail, raw);
        threadsHydrated = true;
      }

      fetched = raw.length;
      options.onProgress?.({ stage: 'fetching', fetched });

      // ---- 2. normalize + persist messages ---------------------------
      const emails: NormalizedEmail[] = [];
      for (const message of raw) {
        const email = mail.normalize(message);
        emails.push(email);

        const pre = prefilter(email);
        repo.upsertMessage(db, {
          email,
          isNoise: pre.decision === 'skip_noise',
          noiseKind: pre.category,
          bodyExcerptChars: config.bodyExcerptChars,
        });
      }

      // ---- 3. analyse -----------------------------------------------
      const engine = new AttentionEngine({
        aiProvider: ai,
        clock,
        minConfidence: config.attention.minConfidence,
        aiMode: config.ai.mode,
        aiMaxCalls: config.ai.maxCallsPerRun,
        userAddress: this.userAddress(),
        onProgress: (p) => options.onProgress?.({ stage: 'analysing', processed: p.processed, total: p.total }),
      });

      const existing = db
        .all<{ event_key: string; category: string; title: string; created_at: string; thread_id: string | null }>(
          `SELECT event_key, category, title, created_at, thread_id FROM items`,
        )
        .map((r) => ({
          eventKey: String(r.event_key),
          category: String(r.category),
          subject: String(r.title),
          createdAt: String(r.created_at),
          threadId: r.thread_id ? String(r.thread_id) : null,
        }));

      const result = await engine.analyze({ messages: emails, existingItems: existing });
      aiCalls = result.stats.aiCalls;
      aiFailures = result.stats.aiFailures;
      degraded = result.stats.degraded;

      // ---- 4. persist analyses + items -------------------------------
      const created: repo.NewItem[] = [];
      const latestByThread = this.latestPerThread(emails);
      const anchorById = new Map<string, NormalizedEmail>();
      for (const email of emails) anchorById.set(email.id, email);

      for (const item of result.items) {
        // The analysis row is anchored to the newest message of the thread,
        // which is the one the verdict was derived from.
        const anchor = latestByThread.get(item.threadId ?? '') ?? latestByThread.get(item.sourceThreadId ?? '');
        if (anchor) {
          repo.saveAnalysis(
            db,
            anchor.id,
            anchor.threadId,
            {
              isAttentionItem: true,
              category: item.category,
              priority: item.priority,
              title: item.title,
              summary: item.summary,
              whyItMatters: item.whyItMatters,
              recommendedAction: item.recommendedAction,
              deadline: item.deadline,
              confidence: item.confidence,
              signals: [],
              suppressionReason: null,
            },
            item.decidedBy,
          );
        }
      }

      // Suppressed verdicts are persisted too. The audit route reads from
      // `analyses`, so without this row "why was this filtered?" can only be
      // answered from the run summary counts, not per message. A suppressed
      // message has no draft title or action, so those fields are empty rather
      // than invented.
      for (const entry of result.suppressed) {
        const email = anchorById.get(entry.messageId);
        if (!email) continue;
        repo.saveAnalysis(
          db,
          email.id,
          email.threadId || email.id,
          {
            isAttentionItem: false,
            category: entry.category,
            priority: 'low',
            title: '',
            summary: entry.detail,
            whyItMatters: '',
            recommendedAction: '',
            deadline: { iso: null, raw: '', kind: 'explicit', confidence: 0 },
            confidence: entry.confidence,
            signals: [],
            suppressionReason: `${entry.reason}: ${entry.detail}`,
          },
          'rules',
        );
      }

      for (const item of result.items) {
        if (repo.findItemByEventKey(db, item.eventKey)) continue;
        created.push(this.toNewItem(item));
      }

      db.transaction(() => {
        for (const item of created) repo.insertItem(db, item);
      });
      options.onProgress?.({ stage: 'persisting', count: created.length });

      // ---- 5. notify --------------------------------------------------
      const openItems = repo.listItems(db, { statuses: ['open'], limit: 200 });
      for (const item of openItems) {
        if (
          !notifications.shouldNotify(
            item,
            config.attention.notifyMode,
            config.attention.minConfidence,
          )
        ) {
          continue;
        }
        notifications.notify({
          itemId: item.id,
          title: item.title,
          body: buildNotificationBody(item),
          priority: item.priority,
          category: item.category,
          deadlineIso: item.deadlineIso,
          gmailUrl: mail.getMessageUrl(item.sourceMessageId),
        });
        notifications.markNotified(item.id);
        repo.markNotified(db, item.id);
      }

      const summary: RunSummary = {
        runId,
        fetched,
        analysed: result.stats.total - result.stats.prefilteredNoise,
        skippedNoise: result.stats.prefilteredNoise,
        newItems: created.length,
        openItems: repo.countOpenItems(db),
        suppressed: result.suppressed,
        aiCalls,
        aiFailures,
        degraded,
        durationMs: clock.now().getTime() - startedAt.getTime(),
      };

      repo.finishRun(db, runId, {
        fetched,
        analysed: summary.analysed,
        skipped: result.stats.prefilteredNoise,
        itemsOpen: summary.openItems,
        aiCalls,
        degraded,
        error: null,
      });

logger.info('Analysis run complete', {
      runId,
      fetched,
      newItems: created.length,
      openItems: summary.openItems,
      aiCalls,
      degraded,
      threadsHydrated,
    });

      return summary;
    } catch (err) {
      const appError = fromMailError(err);
      logger.error('Analysis run failed', {
        runId,
        code: appError.code,
        message: appError.message,
      });
      repo.finishRun(db, runId, {
        fetched,
        analysed: 0,
        skipped: 0,
        itemsOpen: repo.countOpenItems(db),
        aiCalls,
        degraded: true,
        error: appError.message.slice(0, 300),
      });
      throw appError;
    }
  }

  /**
   * Replaces each fetched message with its full thread, deduplicated by id.
   *
   * Threads already complete in the fetched set are left alone, which keeps the
   * fixture demo and any caller that passes complete threads untouched. A
   * thread fetch that fails falls back to the messages already known rather than
   * failing the run: partial context is better than no analysis, and the engine
   * treats a missing reply as "unresolved", which only costs a resurfaced item.
   */
  private async hydrateThreads(
    mail: MailProvider,
    raw: RawMessage[],
  ): Promise<RawMessage[]> {
    const byThread = new Map<string, RawMessage[]>();
    for (const message of raw) {
      const key = message.threadId || message.id;
      const list = byThread.get(key);
      if (list) list.push(message);
      else byThread.set(key, [message]);
    }

    const merged = new Map<string, RawMessage>();

    for (const [threadId, known] of byThread) {
      let full = known;
      if (known.length < FULL_THREAD_HINT) {
        try {
          const fetched = await mail.fetchThread(threadId);
          if (fetched.length > known.length) full = fetched;
        } catch (err) {
          logger.warn('Thread fetch failed; analysing the fetched messages only', {
            threadId,
            code: fromMailError(err).code,
          });
        }
      }
      for (const message of full) {
        if (merged.has(message.id)) continue;
        merged.set(message.id, message);
      }
    }

    // Newest first, matching `fetchRecentMessages`, so the engine sees recent
    // messages early and can stop reasoning about a thread it has resolved.
    return [...merged.values()].sort((a, b) => {
      const at = a.internalDateMs ?? 0;
      const bt = b.internalDateMs ?? 0;
      if (at !== bt) return bt - at;
      return a.id < b.id ? 1 : -1;
    });
  }

  private toNewItem(item: EngineItem): repo.NewItem {
    return {
      id: randomUUID(),
      eventKey: item.eventKey,
      threadId: item.threadId,
      sourceMessageId: item.sourceMessageId,
      sourceThreadId: item.sourceThreadId,
      category: item.category,
      priority: item.priority,
      confidence: item.confidence,
      title: item.title,
      summary: item.summary,
      why: item.whyItMatters,
      action: item.recommendedAction,
      deadlineIso: item.deadline.iso,
      deadlineRaw: item.deadline.raw,
      status: 'open',
      resolvedReason: null,
      decidedBy: item.decidedBy,
    };
  }

  private latestPerThread(emails: NormalizedEmail[]): Map<string, NormalizedEmail> {
    const map = new Map<string, NormalizedEmail>();
    for (const email of emails) {
      const key = email.threadId || email.id;
      const existing = map.get(key);
      if (!existing || email.date.getTime() > existing.date.getTime()) map.set(key, email);
    }
    return map;
  }

  private userAddress(): string | null {
    return this.deps.mail.getAccount()?.email ?? null;
  }
}

/** Converts stored items into the browser-facing projection. */
export function toItemViews(
  db: Database,
  items: AttentionItem[],
  mail: MailProvider,
): Array<Record<string, unknown>> {
  return items.map((item) => {
    const source = repo.getSourceInfo(db, item.sourceMessageId);
    return {
      id: item.id,
      priority: item.priority,
      category: item.category,
      title: item.title,
      summary: item.summary,
      whyItMatters: item.whyItMatters,
      recommendedAction: item.recommendedAction,
      // The `kind` stored alongside the item is not persisted separately; the
      // UI only uses `raw` for display, so this is always "explicit" for items
      // whose date came from a specific day rather than a duration.
      deadline:
        item.deadlineIso !== null
          ? {
              iso: item.deadlineIso,
              raw: item.deadlineRaw ?? '',
              kind: /^(?:within|expires in|in \d)/i.test(item.deadlineRaw ?? '')
                ? 'relative'
                : 'explicit',
              confidence: 0.8,
            }
          : null,
      confidence: item.confidence,
      status: item.status,
      sourceMessageId: item.sourceMessageId,
      sourceThreadId: item.sourceThreadId,
      gmailUrl: mail.getMessageUrl(item.sourceMessageId),
      source: {
        sender: source?.fromName ?? source?.fromAddr ?? 'unknown sender',
        // A reply whose "Re:" prefix was stripped to nothing still needs a
        // subject for the user to recognise.
        subject: source?.subject?.trim() ? source.subject : '(no subject)',
        receivedAt: source ? new Date(source.internalDate).toISOString() : item.createdAt,
        excerpt: source?.excerpt ?? '',
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      decidedBy: item.decidedBy,
    };
  });
}


