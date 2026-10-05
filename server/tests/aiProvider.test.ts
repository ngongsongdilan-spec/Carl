import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, AIProviderError } from '../src/ai/openaiCompatible.js';
import { createAIProvider } from '../src/ai/factory.js';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import { OpenAIChatClient, ChatClientError } from '../src/ai/chatClient.js';
import type { NormalizedEmail, ThreadContext } from '../src/domain/types.js';
import { buildThreadContext } from '../src/attention/threader.js';
import { toNormalizedEmail } from '../src/mail/normalize.js';
import { loadConfig } from '../src/config/env.js';
import type { Clock } from '../src/util/clock.js';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const clock: Clock = { now: () => NOW };

function makeEmail(raw: string, labels: string[] = ['INBOX']): NormalizedEmail {
  return toNormalizedEmail({
    id: 'm1',
    threadId: 't1',
    internalDateMs: NOW.getTime(),
    snippet: '',
    labelIds: labels,
    raw,
  });
}

const RAW = [
  'From: Priya Raman <priya@partner.example>',
  'To: demo@local.test',
  'Subject: Please confirm the integration plan',
  'Date: Sat, 26 Sep 2026 10:00:00 +0000',
  '',
  'Please review the plan and let me know by Friday.',
].join('\n');

function jsonResponse(content: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }),
    text: async () => JSON.stringify(content),
  } as unknown as Response;
}

function provider(fetchImpl: ReturnType<typeof vi.fn>, overrides = {}) {
  return new OpenAICompatibleProvider({
    apiKey: 'sk-test-key',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    temperature: 0.1,
    timeoutMs: 5000,
    excerptChars: 900,
    fetchImpl: fetchImpl as never,
    ...overrides,
  });
}

describe('OpenAICompatibleProvider', () => {
  it('is available with an API key', () => {
    expect(provider(vi.fn()).isAvailable()).toBe(true);
  });

  it('is available without a key for a local endpoint', () => {
    const p = provider(vi.fn(), { apiKey: null, baseUrl: 'http://localhost:11434/v1' });
    expect(p.isAvailable()).toBe(true);
  });

  it('is unavailable with no key and a remote endpoint', () => {
    expect(provider(vi.fn(), { apiKey: null }).isAvailable()).toBe(false);
  });

  it('parses a valid verdict', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        is_attention_item: true,
        category: 'requested_response',
        priority: 'medium',
        title: 'Reply needed to Priya',
        summary: 'Priya is waiting on a decision about the plan.',
        why_it_matters: 'She cannot book the meeting until you answer.',
        recommended_action: 'Reply with your decision.',
        deadline: null,
        confidence: 0.8,
      }),
    );

    const verdict = await provider(fetchImpl).analyzeEmail(makeEmail(RAW));
    expect(verdict?.category).toBe('requested_response');
    expect(verdict?.recommendedAction).toBe('Reply with your decision.');
  });

  it('requests JSON output and sends the model the redacted body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ is_attention_item: false }));
    await provider(fetchImpl).analyzeEmail(makeEmail(RAW));

    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.model).toBe('test-model');
    expect(init.headers.Authorization).toBe('Bearer sk-test-key');
    expect(String(init.body)).toContain('UNTRUSTED_EMAIL_CONTENT');
  });

  it('uses analyzeThread for a multi-message thread', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ is_attention_item: false }));
    const context: ThreadContext = buildThreadContext('t1', [makeEmail(RAW)], null);

    await provider(fetchImpl).analyzeThread(context);

    const [, init] = fetchImpl.mock.calls[0];
    expect(String(init.body)).toContain('messageCount');
  });

  it('returns null when the model emits garbage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('I cannot help with that.'));
    expect(await provider(fetchImpl).analyzeEmail(makeEmail(RAW))).toBeNull();
  });

  it('returns null when the response has no content', async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => '',
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(response);
    expect(await provider(fetchImpl).analyzeEmail(makeEmail(RAW))).toBeNull();
  });

  it('throws a retryable error on HTTP 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    await expect(provider(fetchImpl).analyzeEmail(makeEmail(RAW))).rejects.toMatchObject({
      status: 500,
      retryable: true,
    });
  });

  it('throws a non-retryable error on HTTP 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad key' }, 401));
    await expect(provider(fetchImpl).analyzeEmail(makeEmail(RAW))).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });
  });

  it('throws a retryable error on HTTP 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    await expect(provider(fetchImpl).analyzeEmail(makeEmail(RAW))).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });

  it('throws a retryable error when the network fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(provider(fetchImpl).analyzeEmail(makeEmail(RAW))).rejects.toBeInstanceOf(AIProviderError);
  });

  it('returns null without calling fetch when unavailable', async () => {
    const fetchImpl = vi.fn();
    const p = provider(fetchImpl, { apiKey: null });
    expect(await p.analyzeEmail(makeEmail(RAW))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversized response without throwing an unexpected error', async () => {
    const huge = { ...VALIDISH, summary: 'x'.repeat(50_000) };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(huge));
    const verdict = await provider(fetchImpl).analyzeEmail(makeEmail(RAW));
    expect(verdict!.summary.length).toBeLessThanOrEqual(500);
  });
});

const VALIDISH = {
  is_attention_item: true,
  category: 'deadline',
  priority: 'high',
  title: 'Deadline',
  summary: 'Something is due.',
  why_it_matters: 'Missing it has consequences.',
  recommended_action: 'Do the thing.',
  deadline: null,
  confidence: 0.7,
};

describe('createAIProvider', () => {
  const base = loadConfig({ ai: { ...loadConfig().ai, mode: 'off', apiKey: null } });

  it('returns the heuristic provider when AI_MODE=off', () => {
    expect(createAIProvider(base)).toBeInstanceOf(HeuristicProvider);
  });

  it('returns the heuristic provider when no key is set', () => {
    const hybrid = loadConfig({ ai: { ...base.ai, mode: 'hybrid', apiKey: null } });
    expect(createAIProvider(hybrid)).toBeInstanceOf(HeuristicProvider);
  });

  it('returns an OpenAI-compatible provider when a key is set', () => {
    const hybrid = loadConfig({
      ai: { ...base.ai, mode: 'hybrid', apiKey: 'sk-abc', baseUrl: 'https://api.example.com/v1' },
    });
    expect(createAIProvider(hybrid)).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('never throws on an odd configuration', () => {
    const odd = loadConfig({ ai: { ...base.ai, mode: 'ai', apiKey: null } });
    expect(() => createAIProvider(odd)).not.toThrow();
  });
});

describe('HeuristicProvider', () => {
  it('contributes nothing so the rules carry the decision', async () => {
    const p = new HeuristicProvider();
    expect(await p.analyzeEmail(makeEmail(RAW))).toBeNull();
    expect(p.isAvailable()).toBe(true);
  });
});

describe('OpenAIChatClient', () => {
  it('returns null when disabled', () => {
    const client = OpenAIChatClient.fromConfig(loadConfig({ ai: { ...loadConfig().ai, mode: 'off', apiKey: null } }));
    expect(client).toBeNull();
  });

  it('completes a prompt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Rephrased answer.' } }] }),
    } as unknown as Response);

    const client = new OpenAIChatClient({
      apiKey: 'sk-x',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      temperature: 0.1,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as never,
    });

    expect(await client.complete('sys', 'user')).toBe('Rephrased answer.');
  });

  it('throws ChatClientError on a non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const client = new OpenAIChatClient({
      apiKey: 'sk-x',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      temperature: 0.1,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as never,
    });
    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(ChatClientError);
  });
});
