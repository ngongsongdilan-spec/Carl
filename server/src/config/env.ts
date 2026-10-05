import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Loads `.env` without a hard dependency on dotenv's behaviour, then validates
 * everything into a typed object. Nothing here throws for *missing* values --
 * the app is required to boot with no configuration at all.
 */

/**
 * Walks up from the current directory to the workspace root.
 *
 * Identified by `package.json` declaring the `workspaces` field rather than by
 * looking for a `.env` file: the root has to be findable on a fresh clone where
 * no `.env` exists yet, and it is also what `data/` and `web/dist` are resolved
 * relative to. Using `.env` as the marker meant `rootDir` collapsed to
 * `server/` on exactly the machines that had not configured anything yet.
 */
function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (parsed.workspaces !== undefined) return dir;
      } catch {
        // Unreadable package.json: keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

function loadDotEnv(): void {
  const root = findRepoRoot(process.cwd());
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function float(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export type AiMode = 'off' | 'hybrid' | 'ai';
export type NotifyMode = 'off' | 'high' | 'all';

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  webAppUrl: string;
  sessionSecret: string;
  sessionSecretProvided: boolean;
  google: GoogleCredentials | null;
  googleSkipConsentScreen: boolean;
  ai: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
    mode: AiMode;
    maxCallsPerRun: number;
    timeoutMs: number;
    temperature: number;
  };
  attention: {
    messageLimit: number;
    minConfidence: number;
    notifyMode: NotifyMode;
  };
  dataDir: string;
  dbPath: string;
  cacheTtlDays: number;
  bodyExcerptChars: number;
  aiExcerptChars: number;
  gmailQuery: string;
  rootDir: string;
}

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function loadGoogleCredentials(port: number): GoogleCredentials | null {
  const redirectUri = `http://localhost:${port}/api/auth/google/callback`;

  const envId = str('GOOGLE_CLIENT_ID');
  const envSecret = str('GOOGLE_CLIENT_SECRET');
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, redirectUri };
  }

  const root = findRepoRoot(process.cwd());
  const explicit = str('GOOGLE_CREDENTIALS_PATH');
  const candidates = explicit
    ? [path.isAbsolute(explicit) ? explicit : path.resolve(root, explicit)]
    : [path.join(root, 'credentials.json'), path.join(process.cwd(), 'credentials.json')];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      const inner =
        (parsed.web as Record<string, unknown> | undefined) ??
        (parsed.installed as Record<string, unknown> | undefined) ??
        parsed;
      const clientId = typeof inner.client_id === 'string' ? inner.client_id : '';
      const clientSecret = typeof inner.client_secret === 'string' ? inner.client_secret : '';
      if (clientId && clientSecret) {
        const fromFile =
          typeof inner.redirect_uris === 'object' && Array.isArray(inner.redirect_uris)
            ? (inner.redirect_uris as unknown[]).find((u) => typeof u === 'string')
            : undefined;
        return {
          clientId,
          clientSecret,
          redirectUri: typeof fromFile === 'string' ? fromFile : redirectUri,
        };
      }
    } catch {
      // A malformed credentials file must not stop the app from booting.
    }
  }
  return null;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnvRaw = str('NODE_ENV', 'development');
  const env: AppConfig['env'] =
    nodeEnvRaw === 'production' ? 'production' : nodeEnvRaw === 'test' ? 'test' : 'development';

  const port = int('PORT', 8787);
  const providedSecret = str('SESSION_SECRET');
  const sessionSecret = providedSecret || crypto.randomBytes(32).toString('hex');

  const aiKey = str('AI_API_KEY') || null;
  const aiModeRaw = str('AI_MODE', 'hybrid').toLowerCase();
  const aiMode: AiMode =
    aiModeRaw === 'off' ? 'off' : aiModeRaw === 'ai' ? 'ai' : aiKey ? 'hybrid' : 'off';

  const notifyRaw = str('NOTIFY_MODE', 'high').toLowerCase();
  const notifyMode: NotifyMode =
    notifyRaw === 'off' ? 'off' : notifyRaw === 'all' ? 'all' : 'high';

  const rootDir = findRepoRoot(process.cwd());
  const dataDir = path.isAbsolute(str('DATA_DIR'))
    ? str('DATA_DIR')
    : path.resolve(rootDir, str('DATA_DIR', './data'));

  const config: AppConfig = {
    env,
    port,
    webAppUrl: str('WEB_APP_URL', 'http://localhost:5173').replace(/\/$/, ''),
    sessionSecret,
    sessionSecretProvided: providedSecret.length > 0,
    google: loadGoogleCredentials(port),
    googleSkipConsentScreen: bool('GOOGLE_SKIP_CONSENT_SCREEN', false),
    ai: {
      apiKey: aiKey,
      baseUrl: str('AI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
      model: str('AI_MODEL', 'gpt-4o-mini'),
      mode: aiMode,
      maxCallsPerRun: Math.max(0, int('AI_MAX_CALLS_PER_RUN', 60)),
      timeoutMs: Math.max(1000, int('AI_TIMEOUT_MS', 25_000)),
      temperature: float('AI_TEMPERATURE', 0.1),
    },
    attention: {
      messageLimit: Math.min(500, Math.max(1, int('ANALYSIS_MESSAGE_LIMIT', 100))),
      minConfidence: Math.min(1, Math.max(0, float('ATTENTION_MIN_CONFIDENCE', 0.55))),
      notifyMode,
    },
    dataDir,
    dbPath: path.join(dataDir, 'attention.db'),
    cacheTtlDays: Math.max(0, int('CACHE_TTL_DAYS', 0)),
    bodyExcerptChars: Math.max(120, int('BODY_EXCERPT_CHARS', 600)),
    aiExcerptChars: Math.max(200, int('AI_EXCERPT_CHARS', 900)),
    gmailQuery: str('GMAIL_QUERY', 'in:anywhere -category:promotions -is:sent').trim(),
    rootDir,
    ...overrides,
  };

  return config;
}

export const config: AppConfig = loadConfig();
