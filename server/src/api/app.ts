import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { bind, type AppContext } from './handler.js';
import * as routes from './routes/index.js';
import { authCallback, disconnect, getAuthStatus, startAuth } from './routes/auth.js';
import { AppError } from '../util/errors.js';
import { logger } from '../logging/logger.js';
import type { NotificationPayload } from '../notifications/service.js';

/**
 * HTTP surface.
 *
 * Security posture:
 *   - CORS restricted to WEB_APP_URL, never `*`
 *   - JSON body cap so a hostile client cannot exhaust memory
 *   - explicit security headers (CSP forbids inline script)
 *   - rate limits on the two expensive endpoints
 *   - OAuth state cookie is HttpOnly + SameSite=Lax
 */

const JSON_LIMIT = '256kb';

export function createApp(ctx: AppContext): Express {
  const app = express();

  app.set('trust proxy', false);
  app.disable('x-powered-by');

  // ---- security headers ----------------------------------------------
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
    next();
  });

  app.use(
    cors({
      origin: ctx.config.webAppUrl,
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
    }),
  );
  app.use(cookieParser(ctx.config.sessionSecret));
  app.use(express.json({ limit: JSON_LIMIT }));

  // ---- routes ---------------------------------------------------------
  app.get('/api/health', bind(routes.health, ctx));
  app.get('/api/config', bind(routes.getConfig, ctx));
  app.get('/api/auth/status', bind(getAuthStatus, ctx));
  app.get('/api/auth/google', bind(startAuth, ctx));
  app.get('/api/auth/google/callback', bind(authCallback, ctx));
  app.post('/api/auth/disconnect', bind(disconnect, ctx));
  app.get('/api/attention', bind(routes.listAttention, ctx));
  app.get('/api/attention/:id', bind(routes.getAttentionItem, ctx));
  app.get('/api/attention/:id/source', bind(routes.getSource, ctx));
  app.post('/api/attention/:id/handled', bind(routes.markHandled, ctx));
  app.post('/api/attention/:id/dismiss', bind(routes.dismissItem, ctx));
  app.post('/api/attention/:id/reopen', bind(routes.reopenItem, ctx));
  app.post('/api/analyze', routes.createAnalysisLimiter(), bind(routes.analyze, ctx));
  app.get('/api/debug/suppressed', bind(routes.listSuppressed, ctx));
  app.get('/api/stream', bind(routes.stream, ctx));
  app.post('/api/ask', routes.createAskLimiter(), bind(routes.ask, ctx));

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'not_found', message: 'No such endpoint.', hint: null },
    });
  });

  // Serve the built frontend when it exists, so `npm start` is a single process.
  const webDist = path.join(ctx.config.rootDir, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  // ---- errors ---------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    if (err instanceof AppError) {
      res.status(err.status).json(err.toJSON());
      return;
    }

    // body-parser reports failures via a `type` discriminator, which is stable
    // across Node versions. Matching on the message alone breaks when Node
    // rewords it, which it has done for JSON syntax errors.
    const errType = (err as { type?: string } | null)?.type;
    if (errType === 'entity.too.large') {
      res.status(413).json({
        error: { code: 'bad_request', message: 'Request body is too large.', hint: null },
      });
      return;
    }
    if (errType === 'entity.parse.failed' || errType === 'encoding.unsupported') {
      res.status(400).json({
        error: { code: 'bad_request', message: 'Request body was not valid JSON.', hint: null },
      });
      return;
    }

    const message = err instanceof Error ? err.message : 'unknown';

    logger.error('Express middleware error', { message });
    res.status(500).json({
      error: { code: 'internal_error', message: 'An unexpected error occurred.', hint: null },
    });
  });

  // ---- notification sink ----------------------------------------------
  // The SSE route subscribes directly; this sink exists so notification
  // decisions remain observable server-side without a browser attached.
  ctx.notifications.addSink((payload: NotificationPayload) => {
    logger.debug('Notification emitted', {
      itemId: payload.itemId,
      priority: payload.priority,
      category: payload.category,
    });
  });

  return app;
}
