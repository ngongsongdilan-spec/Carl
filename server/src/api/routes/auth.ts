import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { handler, type AppContext } from '../handler.js';
import { notConfigured } from '../../util/errors.js';
import { logger } from '../../logging/logger.js';

/**
 * OAuth 2.0 authorization-code flow.
 *
 * Security properties:
 *   - `state` is a cryptographically random value bound to an HttpOnly,
 *     SameSite=Lax cookie and compared on callback (CSRF protection)
 *   - tokens are written straight to the server-side database and are never
 *     returned by any endpoint
 *   - only `gmail.readonly` is requested
 */

const STATE_COOKIE = 'pae_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

/** GET /api/auth/status - connection state only. Never returns token material. */
export const getAuthStatus = handler((req: Request, res: Response, ctx: AppContext) => {
  const configured = ctx.mail.isConfigured();
  const account = configured ? ctx.mail.getAccount() : null;

  res.json({
    configured,
    connected: account !== null,
    email: account?.email ?? null,
    // A precise, non-secret signal for the UI to explain what is missing.
    setupHint: configured
      ? null
      : 'Add credentials.json to the project root, or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart the server. See README section 3.',
    redirectUri: ctx.config.google?.redirectUri ?? null,
  });
});

/** GET /api/auth/google - begin authorization. */
export const startAuth = handler((req: Request, res: Response, ctx: AppContext) => {
  if (!ctx.mail.isConfigured()) {
    throw notConfigured(
      'Gmail is not configured yet.',
      'Place credentials.json in the project root, or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env. See README section 3.',
    );
  }

  const state = crypto.randomBytes(24).toString('hex');
  const url = ctx.mail.getAuthorizationUrl(state);

  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.env === 'production',
    maxAge: STATE_TTL_MS,
    path: '/api/auth',
  });

  logger.info('OAuth authorization started');
  res.redirect(url);
});

/** GET /api/auth/google/callback - complete authorization. */
export const authCallback = handler(async (req: Request, res: Response, ctx: AppContext) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const expected = req.cookies?.[STATE_COOKIE];

  // Always clear the cookie, pass or fail.
  res.clearCookie(STATE_COOKIE, { path: '/api/auth' });

  const googleError = typeof req.query.error === 'string' ? req.query.error : null;
  if (googleError) {
    logger.warn('User declined or Google returned an OAuth error', { error: googleError });
    res.redirect(`${ctx.config.webAppUrl}/?auth=denied`);
    return;
  }

  if (!expected || !state || state !== expected) {
    logger.warn('OAuth state mismatch; rejecting callback');
    res.redirect(`${ctx.config.webAppUrl}/?auth=invalid_state`);
    return;
  }

  if (!code) {
    res.redirect(`${ctx.config.webAppUrl}/?auth=missing_code`);
    return;
  }

  try {
    await ctx.mail.exchangeCode(code);
    logger.info('Gmail connected successfully');
    res.redirect(`${ctx.config.webAppUrl}/?auth=connected`);
  } catch (err) {
    logger.error('Gmail connection failed', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    res.redirect(`${ctx.config.webAppUrl}/?auth=failed`);
  }
});

/** POST /api/auth/disconnect - wipe local tokens. */
export const disconnect = handler((_req: Request, res: Response, ctx: AppContext) => {
  ctx.mail.disconnect();
  logger.info('Gmail disconnected');
  res.json({ connected: false });
});
