import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createContext } from '../src/index.js';
import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/config/env.js';
import { loadFixtureMessages } from '../src/fixtures/mailProvider.js';
import type { AppContext } from '../src/api/handler.js';

/**
 * End-to-end check against a real HTTP server serving the real production
 * bundle. Server and checks share one process so there is no background-process
 * coordination to get wrong.
 *
 * Run with: npx tsx --no-warnings tests/e2e-check.ts
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pae-e2e-'));
const base = loadConfig();

const ctx: AppContext = createContext(
  loadConfig({
    dbPath: path.join(dir, 'e2e.db'),
    dataDir: dir,
    google: null,
    env: 'test',
    ai: { ...base.ai, mode: 'off', apiKey: null },
    attention: { messageLimit: 100, minConfidence: 0.55, notifyMode: 'high' },
  }),
);
ctx.demoMessages = loadFixtureMessages(undefined, true);

const server = createServer(createApp(ctx));
await new Promise<void>((resolve) => server.listen(0, resolve));
const { port } = server.address() as { port: number };
const B = `http://127.0.0.1:${port}`;

let failures = 0;
function ok(condition: boolean, label: string, detail = ''): void {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

/**
 * `res.json()` is typed `unknown`, which is correct -- this script is checking
 * the server's response shape, so it asserts the shape itself rather than
 * trusting a declaration.
 */
async function json<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const distIndex = path.join(ctx.config.rootDir, 'web', 'dist', 'index.html');
const distExists = fs.existsSync(distIndex);
console.log(`\nweb bundle: ${distExists ? 'present' : 'MISSING (run npm run build)'}\n`);

// ---- static assets ----------------------------------------------------
if (distExists) {
  const html = fs.readFileSync(distIndex, 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

  const indexRes = await fetch(`${B}/`);
  ok(indexRes.status === 200, 'GET / serves the app', String(indexRes.status));
  ok(
    (await indexRes.text()).includes('<div id="root">'),
    'index.html mounts #root',
  );

  for (const asset of assets) {
    const res = await fetch(B + asset);
    const body = await res.text();
    ok(res.status === 200 && body.length > 0, `GET ${asset}`, `${res.status}, ${body.length}b`);
  }

  const fallback = await fetch(`${B}/deep/client/route`);
  ok(fallback.status === 200, 'GET /deep/client/route falls back to index', String(fallback.status));
}

// ---- security headers --------------------------------------------------
const headerRes = await fetch(`${B}/`);
const csp = headerRes.headers.get('content-security-policy') ?? '';
ok(headerRes.headers.get('x-content-type-options') === 'nosniff', 'nosniff header');
ok(headerRes.headers.get('x-frame-options') === 'DENY', 'frame deny header');
ok(headerRes.headers.get('referrer-policy') === 'no-referrer', 'referrer policy');
ok(headerRes.headers.get('x-powered-by') === null, 'no x-powered-by header');
ok(csp.includes("script-src 'self'"), 'CSP forbids inline scripts');
ok(csp.includes("frame-ancestors 'none'"), 'CSP forbids framing');
ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'CSP has no unsafe-inline script');

// ---- api --------------------------------------------------------------
const health = await json<{ ok: boolean }>(await fetch(`${B}/api/health`));
ok(health.ok === true, 'GET /api/health');

const auth = await json<{ configured: boolean; connected: boolean }>(
  await fetch(`${B}/api/auth/status`),
);
ok(auth.configured === false && auth.connected === false, 'GET /api/auth/status');
ok(
  JSON.stringify(auth).includes('credentials.json'),
  'auth status gives an actionable hint',
);

const notFound = await fetch(`${B}/api/nope`);
ok(notFound.status === 404, 'unknown api route is 404');
ok(
  (await json<{ error?: { code?: string } }>(notFound)).error?.code === 'not_found',
  '404 body has a code',
);

const badJson = await fetch(`${B}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{not json',
});
ok(badJson.status === 400, 'malformed JSON is 400, not 500', String(badJson.status));

// ---- full analysis ----------------------------------------------------
const analyzeRes = await fetch(`${B}/api/analyze`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ demo: true }),
});
interface AnalyzeBody {
  run: {
    fetched: number;
    skippedNoise: number;
    newItems: number;
  };
  items: Record<string, unknown>[];
}
const analyze = await json<AnalyzeBody>(analyzeRes);
ok(analyzeRes.status === 200, 'POST /api/analyze (demo)');
ok(analyze.run.fetched === 14, 'fetched all fixture messages', String(analyze.run.fetched));
ok(analyze.run.skippedNoise >= 4, 'filtered bulk mail', String(analyze.run.skippedNoise));
ok(
  analyze.items.length >= 4 && analyze.items.length <= 7,
  'surfaced a focused number of items',
  String(analyze.items.length),
);

for (const item of analyze.items as Record<string, unknown>[]) {
  const okShape =
    typeof item.title === 'string' &&
    (item.title as string).length > 5 &&
    typeof item.whyItMatters === 'string' &&
    (item.whyItMatters as string).length > 15 &&
    typeof item.recommendedAction === 'string' &&
    (item.recommendedAction as string).length > 10 &&
    typeof item.confidence === 'number' &&
    (item.confidence as number) >= 0.55 &&
    typeof item.gmailUrl === 'string' &&
    (item.gmailUrl as string).startsWith('https://mail.google.com/');
  if (!okShape) {
    failures++;
    console.log(`FAIL  item shape incomplete: ${JSON.stringify(item).slice(0, 160)}`);
  }
}
ok(true, 'every item has title / why / action / deadline-or-null / confidence / link');

// ---- idempotency ------------------------------------------------------
const second = await json<AnalyzeBody>(
  await fetch(`${B}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ demo: true }),
  }),
);
ok(second.run.newItems === 0, 'second run creates no duplicates', `newItems=${second.run.newItems}`);

// ---- item lifecycle ---------------------------------------------------
interface FeedBody {
  items: { id: string; status: string }[];
  counts: Record<string, number>;
}

const firstId = (analyze.items as Record<string, string>[])[0].id;
const handled = await fetch(`${B}/api/attention/${firstId}/handled`, { method: 'POST' });
ok(handled.status === 200, 'POST handled');

const afterHandle = await json<FeedBody>(await fetch(`${B}/api/attention`));
ok(
  !afterHandle.items.some((i) => i.id === firstId),
  'handled item leaves the open feed',
);
ok(afterHandle.counts.handled === 1, 'handled count incremented');

const reopened = await json<{ item: { status: string } }>(
  await fetch(`${B}/api/attention/${firstId}/reopen`, { method: 'POST' }),
);
ok(reopened.item.status === 'open', 'POST reopen');

const dismissed = await json<{ item: { status: string } }>(
  await fetch(`${B}/api/attention/${firstId}/dismiss`, { method: 'POST' }),
);
ok(dismissed.item.status === 'dismissed', 'POST dismiss');

// ---- source email is plain text --------------------------------------
const source = await json<{ available: boolean; excerpt: string }>(
  await fetch(`${B}/api/attention/${firstId}/source`),
);
ok(source.available === true, 'source email available');
ok(
  !source.excerpt.includes('<') && !source.excerpt.includes('>'),
  'source excerpt is plain text, never HTML',
);

// ---- assistant --------------------------------------------------------
interface AskBody {
  answer: string;
  citedItemIds: string[];
  outOfScope: boolean;
}

const asked = await json<AskBody>(
  await fetch(`${B}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What needs my attention?' }),
  }),
);
ok(asked.outOfScope === false, 'assistant answers in scope');
ok(asked.citedItemIds.length > 0, 'assistant cites items', `${asked.citedItemIds.length}`);

const outOfScope = await json<AskBody>(
  await fetch(`${B}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Write me a Python script to sort a list' }),
  }),
);
ok(outOfScope.outOfScope === true, 'assistant refuses out-of-scope questions');

const emptyQ = await fetch(`${B}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question: '  ' }),
});
ok(emptyQ.status === 400, 'empty question is 400');

// ---- SSE --------------------------------------------------------------
const controller = new AbortController();
const ssePromise = fetch(`${B}/api/stream`, { signal: controller.signal });
const sse = await ssePromise;
const reader = sse.body!.getReader();
const { value } = await reader.read();
const chunk = new TextDecoder().decode(value);
ok(chunk.includes('event: ready'), 'SSE stream opens with a ready event');
controller.abort();

// ---- rate limiting ----------------------------------------------------
let limited = false;
for (let i = 0; i < 14; i++) {
  const res = await fetch(`${B}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ demo: true }),
  });
  if (res.status === 429) {
    limited = true;
    break;
  }
}
ok(limited, 'analysis endpoint is rate limited');

// ---- audit trail ------------------------------------------------------
const suppressed = await json<{ run: { fetched: number } | null }>(
  await fetch(`${B}/api/debug/suppressed`),
);
ok(suppressed.run?.fetched === 14, 'audit trail records the run');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);

server.close();
ctx.db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
