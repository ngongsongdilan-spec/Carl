import type { Request, Response } from 'express';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../util/errors.js';
import { logger } from '../logging/logger.js';
import type { AIProvider } from '../ai/provider.js';
import type { Database } from '../db/database.js';
import type { MailProvider, RawMessage } from '../mail/provider.js';
import type { Pipeline } from '../pipeline/pipeline.js';
import type { Assistant } from '../assistant/assistant.js';
import type { NotificationService } from '../notifications/service.js';

/**
 * The application context: everything a route needs, assembled once.
 *
 * Routes receive this rather than reaching for globals, which is what lets the
 * API tests run against an in-memory database with mocked providers.
 */
export interface AppContext {
  config: AppConfig;
  db: Database;
  mail: MailProvider;
  ai: AIProvider;
  pipeline: Pipeline;
  assistant: Assistant;
  notifications: NotificationService;
  startedAt: number;
  /**
   * Pre-loaded fixture messages, used only by the demo path. Present so the demo
   * exercises the same pipeline as Gmail rather than a parallel code path.
   */
  demoMessages: RawMessage[] | null;
}

export type ApiHandler = (req: Request, res: Response, ctx: AppContext) => Promise<void> | void;

/**
 * Wraps a handler so thrown errors become clean JSON responses. No stack trace
 * or internal message reaches the client; details go to the log only.
 */
export function handler(fn: ApiHandler) {
  return async (req: Request, res: Response, ctx: AppContext): Promise<void> => {
    try {
      await fn(req, res, ctx);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof AppError) {
        if (err.status >= 500) {
          logger.error('Request failed', { code: err.code, message: err.message });
        }
        res.status(err.status).json(err.toJSON());
        return;
      }
      logger.error('Unhandled request error', {
        message: err instanceof Error ? err.message : 'unknown',
        stack:
          err instanceof Error
            ? (err.stack ?? '').split('\n').slice(0, 4).join(' | ')
            : '',
      });
      res.status(500).json({
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred. Check the server logs for details.',
          hint: null,
        },
      });
    }
  };
}

/**
 * Binds a handler to a fixed context, producing a plain Express middleware.
 * Keeps the context in one place instead of threading it through every route.
 */
export function bind(fn: ApiHandler, ctx: AppContext) {
  const wrapped = handler(fn);
  return (req: Request, res: Response): Promise<void> => wrapped(req, res, ctx);
}

/** In-process fixed-window rate limiter for the expensive endpoints. */
export function rateLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: () => void): void => {
    const now = Date.now();
    const key = req.ip ?? 'global';
    const recent = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);

    if (recent.length >= opts.max) {
      res.status(429).json({
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Wait a moment and try again.',
          hint: null,
        },
      });
      return;
    }

    recent.push(now);
    hits.set(key, recent);

    if (hits.size > 500) {
      for (const [k, v] of hits) {
        if (v.every((t) => now - t >= opts.windowMs)) hits.delete(k);
      }
    }
    next();
  };
}
