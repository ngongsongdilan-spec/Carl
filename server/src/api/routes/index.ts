import type { Request, Response } from 'express';
import { handler, rateLimiter, type AppContext } from '../handler.js';
import { toItemViews } from '../../pipeline/pipeline.js';
import * as repo from '../../db/repositories.js';
import { badRequest, notConnected, notConfigured, notFound } from '../../util/errors.js';
import type { ItemStatus } from '../../domain/types.js';

/** GET /api/health */
export const health = handler((_req: Request, res: Response, ctx: AppContext) => {
  const last = repo.lastRun(ctx.db);
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
    gmailConfigured: ctx.mail.isConfigured(),
    gmailConnected: ctx.mail.isConfigured() && ctx.mail.getAccount() !== null,
    aiProvider: ctx.ai.name,
    lastRun: last,
  });
});

/** GET /api/config - non-secret configuration for the UI. */
export const getConfig = handler((_req: Request, res: Response, ctx: AppContext) => {
  const provider =
    'health' in ctx.ai && typeof ctx.ai.health === 'function'
      ? (ctx.ai as { health: () => { name: string; available: boolean; model: string | null; detail: string } }).health()
      : { name: ctx.ai.name, available: ctx.ai.isAvailable(), model: null, detail: '' };

  res.json({
    ai: {
      mode: ctx.config.ai.mode,
      provider: provider.name,
      available: provider.available,
      model: provider.model,
      detail: provider.detail,
    },
    attention: {
      messageLimit: ctx.config.attention.messageLimit,
      minConfidence: ctx.config.attention.minConfidence,
      notifyMode: ctx.config.attention.notifyMode,
    },
    demoMode: !ctx.mail.isConfigured(),
  });
});

const VALID_STATUSES: ItemStatus[] = ['open', 'handled', 'dismissed', 'resolved'];

/**
 * GET /api/attention - the feed.
 *
 * Defaults to open items only, because the product is about what needs
 * attention now, not about history.
 */
export const listAttention = handler((req: Request, res: Response, ctx: AppContext) => {
  const statusParam = typeof req.query.status === 'string' ? req.query.status : 'open';
  const statuses: ItemStatus[] =
    statusParam === 'all'
      ? VALID_STATUSES
      : (VALID_STATUSES.filter((s) => s === statusParam) as ItemStatus[]);
  const limitParam = Number.parseInt(String(req.query.limit ?? '100'), 10);
  const limit = Number.isFinite(limitParam) ? Math.min(200, Math.max(1, limitParam)) : 100;

  const items = repo.listItems(ctx.db, { statuses, limit });
  const views = toItemViews(ctx.db, items, ctx.mail);

  res.json({
    items: views,
    counts: {
      open: repo.countOpenItems(ctx.db),
      handled: repo.countItemsByStatus(ctx.db, ['handled']),
      dismissed: repo.countItemsByStatus(ctx.db, ['dismissed']),
      resolved: repo.countItemsByStatus(ctx.db, ['resolved']),
    },
  });
});

/** GET /api/attention/:id - one item plus its provenance. */
export const getAttentionItem = handler((req: Request, res: Response, ctx: AppContext) => {
  const id = req.params.id;
  if (!id) throw badRequest('Missing item id.');
  const item = repo.getItem(ctx.db, id);
  if (!item) throw notFound('That attention item no longer exists.');

  const source = repo.getSourceInfo(ctx.db, item.sourceMessageId);
  const events = repo.listItemEvents(ctx.db, item.id);

  res.json({
    item: toItemViews(ctx.db, [item], ctx.mail)[0],
    history: events,
    resolvedReason: item.resolvedReason,
  });
});

function setStatus(kind: 'handled' | 'dismissed') {
  return handler((req: Request, res: Response, ctx: AppContext) => {
    const id = req.params.id;
    if (!id) throw badRequest('Missing item id.');
    const item = repo.getItem(ctx.db, id);
    if (!item) throw notFound('That attention item no longer exists.');

    const updated = repo.updateItemStatus(
      ctx.db,
      id,
      kind,
      kind === 'dismissed' ? 'Dismissed by you.' : 'Marked as handled by you.',
    );

    res.json({ item: toItemViews(ctx.db, updated ? [updated] : [], ctx.mail)[0] ?? null });
  });
}

/** POST /api/attention/:id/handled */
export const markHandled = setStatus('handled');

/** POST /api/attention/:id/dismiss */
export const dismissItem = setStatus('dismissed');

/** POST /api/attention/:id/reopen - return a suppressed item to the feed. */
export const reopenItem = handler((req: Request, res: Response, ctx: AppContext) => {
  const id = req.params.id;
  if (!id) throw badRequest('Missing item id.');
  const item = repo.getItem(ctx.db, id);
  if (!item) throw notFound('That attention item no longer exists.');
  const updated = repo.updateItemStatus(ctx.db, id, 'open', null);
  res.json({ item: toItemViews(ctx.db, updated ? [updated] : [], ctx.mail)[0] ?? null });
});

/** GET /api/attention/:id/source - text-only preview of the source email. */
export const getSource = handler((req: Request, res: Response, ctx: AppContext) => {
  const id = req.params.id;
  if (!id) throw badRequest('Missing item id.');
  const item = repo.getItem(ctx.db, id);
  if (!item) throw notFound('That attention item no longer exists.');

  const message = repo.getMessage(ctx.db, item.sourceMessageId);
  if (!message) {
    res.json({
      available: false,
      gmailUrl: ctx.mail.getMessageUrl(item.sourceMessageId),
    });
    return;
  }

  res.json({
    available: true,
    from: message.fromName ? `${message.fromName} <${message.fromAddr}>` : message.fromAddr,
    subject: message.subject,
    receivedAt: new Date(message.internalDate).toISOString(),
    // Plain text only. The client renders it as text content and never as HTML.
    excerpt: message.bodyExcerpt,
    gmailUrl: ctx.mail.getMessageUrl(message.messageId ?? item.sourceMessageId),
  });
});

/** POST /api/analyze - run the pipeline over recent mail. */
export const analyze = handler(async (req: Request, res: Response, ctx: AppContext) => {
  const body = (req.body ?? {}) as { limit?: number; demo?: boolean };
  const limit =
    typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.min(500, Math.max(1, Math.floor(body.limit)))
      : ctx.config.attention.messageLimit;

  if (!body.demo && !ctx.mail.isConfigured()) {
    throw notConfigured(
      'Gmail is not configured, so real mail cannot be analysed.',
      ctx.config.google
        ? undefined
        : 'Add credentials.json or set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET. Or use the demo inbox to try the engine without Gmail.',
    );
  }
  if (!body.demo && !ctx.mail.getAccount()) {
    throw notConnected(
      'No Gmail account is connected.',
      'Click "Connect Gmail" on the connection screen, or use the demo inbox.',
    );
  }

  const summary = await ctx.pipeline.run({
    limit,
    source: body.demo === true ? ctx.demoMessages ?? undefined : null,
  });

  res.json({
    run: {
      fetched: summary.fetched,
      analysed: summary.analysed,
      skippedNoise: summary.skippedNoise,
      newItems: summary.newItems,
      openItems: summary.openItems,
      aiCalls: summary.aiCalls,
      degraded: summary.degraded,
      durationMs: summary.durationMs,
    },
    items: toItemViews(ctx.db, repo.listItems(ctx.db, { statuses: ['open'], limit: 100 }), ctx.mail),
  });
});

/**
 * GET /api/stream - Server-Sent Events for browser notifications.
 *
 * Notifications are delivered to the open tab only. This is the simple,
 * local-only implementation described in PRODUCT_SPEC §9; a real push channel
 * would replace this file.
 */
export const stream = handler((req: Request, res: Response, ctx: AppContext) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  const unsubscribe = ctx.notifications.onNotification((payload) => {
    try {
      res.write(`event: notification\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      unsubscribe();
    }
  });

  // Comment frames keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** POST /api/ask - the scoped assistant. */
export const ask = handler(async (req: Request, res: Response, ctx: AppContext) => {
  const body = (req.body ?? {}) as { question?: string };
  const question = typeof body.question === 'string' ? body.question.trim() : '';

  if (question.length === 0) {
    throw badRequest('Ask a question, for example "What needs my attention?".');
  }
  if (question.length > 500) {
    throw badRequest('That question is too long. Keep it under 500 characters.');
  }

  const answer = await ctx.assistant.ask(question);
  res.json(answer);
});

/** GET /api/debug/suppressed - the audit trail of what was filtered and why. */
export const listSuppressed = handler(async (_req: Request, res: Response, ctx: AppContext) => {
  const last = repo.lastRun(ctx.db);
  if (!last) {
    res.json({ run: null, suppressed: [] });
    return;
  }

  const analyses = ctx.db
    .all<Record<string, unknown>>(
      `SELECT a.suppression, a.confidence, a.category, m.subject, m.from_addr
       FROM analyses a JOIN messages m ON m.gmail_id = a.message_id
       WHERE a.is_attention = 0 AND a.suppression IS NOT NULL
       ORDER BY a.created_at DESC LIMIT 100`,
    )
    .map((row) => ({
      suppression: String(row.suppression),
      confidence: Number(row.confidence ?? 0),
      category: String(row.category),
      subject: String(row.subject ?? ''),
      sender: String(row.from_addr ?? ''),
    }));

  res.json({ run: last, suppressed: analyses });
});

/**
 * Rate limiters are created per application instance rather than at module
 * scope. A module-level limiter would be shared by every app built in the
 * process, leaking state between tests and letting one instance throttle
 * another.
 */
export function createAnalysisLimiter(): ReturnType<typeof rateLimiter> {
  return rateLimiter({ windowMs: 60_000, max: 10 });
}

export function createAskLimiter(): ReturnType<typeof rateLimiter> {
  return rateLimiter({ windowMs: 60_000, max: 30 });
}

