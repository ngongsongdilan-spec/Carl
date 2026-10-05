import fs from 'node:fs';
import { config, loadConfig, type AppConfig } from './config/env.js';
import { setLogLevel } from './logging/logger.js';
import { logger } from './logging/logger.js';
import { Database } from './db/database.js';
import { createAIProvider, describeProvider } from './ai/factory.js';
import { OpenAIChatClient } from './ai/chatClient.js';
import { GmailService } from './mail/gmail.js';
import { EmitterNotificationService } from './notifications/service.js';
import { Pipeline } from './pipeline/pipeline.js';
import { Assistant } from './assistant/assistant.js';
import { createApp } from './api/app.js';
import type { AppContext } from './api/handler.js';
import { systemClock } from './util/clock.js';
import { loadFixtureMessages } from './fixtures/mailProvider.js';
import { createServer } from 'node:http';

/**
 * Composition root.
 *
 * Everything is constructed here and injected downwards. `createContext` is
 * exported separately so tests can build a context against an in-memory
 * database and mocked providers.
 */

/**
 * Builds a context. `overrides` are merged over the loaded configuration, which
 * lets tests supply an in-memory database path or disable the AI without
 * touching the environment.
 */
function stripUndefined(overrides: Partial<AppConfig>): Partial<AppConfig> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<AppConfig>;
}

export function createContext(overrides: Partial<AppConfig> = {}): AppContext {
  const appConfig: AppConfig = { ...config, ...stripUndefined(overrides) };

  fs.mkdirSync(appConfig.dataDir, { recursive: true, mode: 0o700 });

  const db = new Database(appConfig.dbPath);
  const ai = createAIProvider(appConfig);
  const mail = new GmailService({ config: appConfig, db, clock: systemClock });
  const notifications = new EmitterNotificationService();

  const pipeline = new Pipeline({
    config: appConfig,
    db,
    mail,
    ai,
    notifications,
    clock: systemClock,
  });

  const chat = OpenAIChatClient.fromConfig(appConfig);
  const assistant = new Assistant({ config: appConfig, db, clock: systemClock, mail, chat });

  return {
    config: appConfig,
    db,
    mail,
    ai,
    pipeline,
    assistant,
    notifications,
    startedAt: Date.now(),
    // The demo path shifts fixture dates so their deadlines stay in the
    // future; see FixtureProvider for why.
    demoMessages: loadFixtureMessages(undefined, true),
  };
}

async function main(): Promise<void> {
  const appConfig = loadConfig();
  setLogLevel(appConfig.env === 'test' ? 'error' : (process.env.LOG_LEVEL as never) ?? 'info');

  const ctx = createContext(appConfig);
  const app = createApp(ctx);
  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(appConfig.port, () => {
      logger.info('Personal Attention Engine is running', {
        port: appConfig.port,
        env: appConfig.env,
        webAppUrl: appConfig.webAppUrl,
      });
      resolve();
    });
  });

  const aiHealth = describeProvider(ctx.ai);
  logger.info('Configuration', {
    gmailConfigured: ctx.mail.isConfigured(),
    gmailConnected: ctx.mail.isConfigured() && ctx.mail.getAccount() !== null,
    aiProvider: aiHealth.name,
    aiAvailable: aiHealth.available,
    aiMode: appConfig.ai.mode,
    messageLimit: appConfig.attention.messageLimit,
    notifyMode: appConfig.attention.notifyMode,
    sessionSecretProvided: appConfig.sessionSecretProvided,
    dataDir: appConfig.dataDir,
  });

  if (!appConfig.google) {
    logger.warn(
      'Gmail is NOT configured. The attention engine and demo inbox work without it. To connect a real mailbox, place credentials.json in the project root or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (see README section 3).',
    );
  }
  if (!appConfig.ai.apiKey) {
    logger.info('No AI_API_KEY set. Using the deterministic analyzer; every feature still works.');
  }

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(() => {
      ctx.db.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');

if (isDirectRun || process.env.PAE_FORCE_START === '1') {
  main().catch((err: unknown) => {
    logger.error('Fatal startup error', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    process.exit(1);
  });
}

export { config, createApp };
