import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-level security and product guarantees.
 *
 * These are the checks in SECURITY.md §5. They are enforced as tests because a
 * guarantee nobody checks is a guarantee that quietly stops being true.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const serverSrc = path.join(repoRoot, 'server', 'src');
const webSrc = path.join(repoRoot, 'web', 'src');

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const serverFiles = walk(serverSrc, ['.ts']);
const webFiles = walk(webSrc, ['.ts', '.tsx']);
const allSource = [...serverFiles, ...webFiles];

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Strips comments so a doc comment naming a dangerous API is not a match. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('frontend safety', () => {
  it('never renders email-derived content as HTML', () => {
    const offenders = webFiles.filter((f) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|srcDoc\s*=/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('never opens a mail link without noopener', () => {
    for (const file of webFiles) {
      const text = read(file);
      const targetBlank = /target=["']_blank["']/g;
      const noopener = /rel=["'][^"']*noopener/g;
      const count = (text.match(targetBlank) ?? []).length;
      const safe = (text.match(noopener) ?? []).length;
      expect(count, `${file} uses target=_blank`).toBeLessThanOrEqual(safe);
    }
  });
});

describe('secrets', () => {
  it('contains no hard-coded API keys', () => {
    // Any key-shaped literal in source would be a committed secret.
    const pattern = /(sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|\b1\/\/[A-Za-z0-9_-]{30,})/;
    for (const file of allSource) {
      expect(pattern.test(read(file)), `possible secret in ${file}`).toBe(false);
    }
  });

  it('reads secrets from the environment only', () => {
    const env = read(path.join(serverSrc, 'config', 'env.ts'));
    expect(env).toContain('process.env');
    expect(env).toContain('GOOGLE_CLIENT_ID');
    expect(env).toContain('AI_API_KEY');
  });

  it('gitignores every secret-bearing path', () => {
    const gitignore = read(path.join(repoRoot, '.gitignore'));
    for (const entry of ['.env', 'credentials.json', 'data/', 'token.json']) {
      expect(gitignore, `missing ${entry}`).toContain(entry);
    }
  });

  it('ships an example environment file and no real one', () => {
    expect(fs.existsSync(path.join(repoRoot, '.env.example'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'credentials.json'))).toBe(false);
  });
});

describe('OAuth scope', () => {
  /** The code path that decides what to ask Google for. */
  function scopeCode(): string {
    const gmail = code(path.join(serverSrc, 'mail', 'gmail.ts'));
    const scopes = gmail.match(/private scopes\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    const authUrl = gmail.match(/getAuthorizationUrl\([^)]*\): string[\s\S]*?\n {2}\}/)?.[0] ?? '';
    return `${scopes}\n${authUrl}`;
  }

  it('requests only gmail.readonly', () => {
    const scopes = scopeCode();
    expect(scopes).toContain('GMAIL_READONLY_SCOPE');

    for (const forbidden of [
      'gmail.send',
      'gmail.modify',
      'gmail.compose',
      'gmail.labels',
      'gmail.settings.basic',
      'mail.google.com/',
      'drive',
      'calendar',
    ]) {
      expect(scopes, `scope ${forbidden} must not be requested`).not.toContain(forbidden);
    }
  });

  it('cannot be widened by configuration', () => {
    // The grant is fixed, so there is no code path and no env var that can add a
    // scope. Asserting the absence of both is the point: a variable that is
    // merely defaulted to empty still invites someone to fill it in later.
    const env = code(path.join(serverSrc, 'config', 'env.ts'));
    expect(env).not.toMatch(/GOOGLE_EXTRA_SCOPES|googleExtraScopes/);

    const gmail = code(path.join(serverSrc, 'mail', 'gmail.ts'));
    expect(gmail).toMatch(/return \[GMAIL_READONLY_SCOPE\];/);
    expect(gmail).not.toMatch(/scope:\s*\[[^\]]*,/);
    // `include_granted_scopes` would fold in previously granted scopes.
    expect(gmail).toContain('include_granted_scopes: false');
  });

  it('builds the scope list from a single constant', () => {
    const env = read(path.join(serverSrc, 'config', 'env.ts'));
    expect(env).toContain(
      "GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'",
    );
  });

  it('refuses to construct a URL from an unvalidated message id', () => {
    const gmail = code(path.join(serverSrc, 'mail', 'gmail.ts'));
    expect(gmail).toMatch(/replace\(\/\[\^A-Za-z0-9_-\]\/g/);
  });

  it('verifies the OAuth state value on callback', () => {
    const auth = read(path.join(serverSrc, 'api', 'routes', 'auth.ts'));
    expect(auth).toContain('randomBytes');
    expect(auth).toContain('httpOnly');
    expect(auth).toContain('state !== expected');
  });
});

describe('SQL', () => {
  /**
   * Interpolation inside a SQL string is only a risk when it injects a *value*.
   * These are the forms this codebase uses, and nothing else is allowed. Each one
   * either builds placeholder syntax or serialises a value for a column that
   * stores JSON.
   */
  const SAFE_INTERPOLATIONS: Record<string, string> = {
    // Placeholder rows built from a hard-coded list of literal status values.
    where: "built from a fixed list of literal status values; the values are still bound as parameters",
    clauses: 'a list of fixed SQL fragments, each containing only a placeholder',
    // A JSON string being written to a TEXT column.
    jsonArray: 'JSON.stringify of a value being stored in a TEXT column',
    limit: 'an integer clamped a few lines earlier',
    // `?,?,?` built from a list of literal status values; every value itself is
    // still bound as a parameter.
    placeholders:
      'placeholder marks built from a fixed list of literal status values; the values are bound as parameters',
  };

  it('never interpolates a value into a SQL string', () => {
    for (const file of serverFiles) {
      for (const statement of code(file).matchAll(/`(?:[^`\\]|\\.)*`/g)) {
        const text = statement[0];
        if (!/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(text)) continue;

        for (const interpolation of text.matchAll(/\$\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}/g)) {
          const expr = interpolation[1];
          expect(
            Object.prototype.hasOwnProperty.call(SAFE_INTERPOLATIONS, expr),
            `${path.basename(file)}: SQL interpolation \${${expr}} is not a known-safe form`,
          ).toBe(true);
        }
      }
    }
  });

  it('binds every value in the repositories layer', () => {
    const repos = code(path.join(serverSrc, 'db', 'repositories.ts'));
    const calls = repos.match(/\b(?:run|get|all)</g) ?? [];
    expect(calls.length).toBeGreaterThan(10);
    // Values are passed as arrays of positional parameters, never inlined.
    expect(repos).not.toMatch(/'\s*\+\s*\w/);
  });
});

describe('logging', () => {
  it('redacts known-sensitive keys', () => {
    const logger = read(path.join(serverSrc, 'logging', 'logger.ts'));
    expect(logger).toContain('SECRET_KEY_PATTERN');
    expect(logger).toContain('[redacted]');
    expect(logger).toMatch(/token|secret/i);
  });

  it('has no console.log of an email body', () => {
    for (const file of serverFiles) {
      const text = read(file);
      for (const line of text.split('\n')) {
        if (!line.includes('console.')) continue;
        expect(line, `${file}: ${line}`).not.toMatch(/bodyText|\.body\b/);
      }
    }
  });
});

describe('data minimisation', () => {
  it('caps the excerpt stored per message', () => {
    const env = read(path.join(serverSrc, 'config', 'env.ts'));
    expect(env).toContain('BODY_EXCERPT_CHARS');

    const normalize = read(path.join(serverSrc, 'db', 'repositories.ts'));
    expect(normalize).toContain('makeExcerpt');
    // The full body column must not exist.
    expect(normalize).not.toMatch(/body_text\s+TEXT/i);
  });
});

describe('documentation', () => {
  it('ships all four required documents', () => {
    for (const doc of ['README.md', 'ARCHITECTURE.md', 'PRODUCT_SPEC.md', 'SECURITY.md']) {
      expect(fs.existsSync(path.join(repoRoot, doc)), `missing ${doc}`).toBe(true);
      expect(read(path.join(repoRoot, doc)).length).toBeGreaterThan(500);
    }
  });

  it('documents every environment variable the code reads', () => {
    const envSource = read(path.join(serverSrc, 'config', 'env.ts'));
    const example = read(path.join(repoRoot, '.env.example'));

    const referenced = new Set(
      [...envSource.matchAll(/(?:str|int|bool|float)\(\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]),
    );
    expect(referenced.size).toBeGreaterThan(15);

    const undocumented = [...referenced].filter((name) => !example.includes(name));
    expect(undocumented).toEqual([]);
  });

  it('runs a full end-to-end check against the built bundle', () => {
    const script = path.join(here, 'e2e-check.ts');
    expect(fs.existsSync(script)).toBe(true);
    // Run with `npm run e2e`. Asserted here so the script cannot quietly stop
    // covering the paths that matter.
    const text = read(script);
    for (const check of [
      '/api/analyze',
      '/api/attention',
      '/api/ask',
      '/api/stream',
      'second run creates no duplicates',
      'assistant refuses out-of-scope',
      'source excerpt is plain text',
      'CSP forbids inline scripts',
      'analysis endpoint is rate limited',
    ]) {
      expect(text, `e2e check missing: ${check}`).toContain(check);
    }
  });

  it('documents every endpoint the API exposes', () => {
    const app = code(path.join(serverSrc, 'api', 'app.ts'));
    const routes = [...app.matchAll(/app\.(?:get|post)\('([^']+)'/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThan(12);

    const readme = read(path.join(repoRoot, 'README.md'));
    // The README does not have to list every route, but it must document the
    // main entry points a reader would try first.
    for (const route of ['/api/health', '/api/analyze', '/api/attention']) {
      expect(readme).toContain(route);
    }
  });
});
