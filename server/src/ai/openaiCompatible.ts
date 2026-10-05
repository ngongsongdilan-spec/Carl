import type { AIVerdict, NormalizedEmail, ThreadContext } from '../domain/types.js';
import type { AIProvider, ProviderHealth } from './provider.js';
import { buildEmailPrompt, buildThreadPrompt } from './prompts.js';
import { parseModelResponse } from './validate.js';
import { logger } from '../logging/logger.js';
import type { AppConfig } from '../config/env.js';

/**
 * Any provider that speaks the OpenAI `/chat/completions` API.
 *
 * That covers OpenAI, Groq, Together, OpenRouter, DeepSeek, SiliconFlow, and a
 * local Ollama / LM Studio server. One class, many backends.
 */

export interface FetchLike {
  (input: string, init: RequestInit): Promise<Response>;
}

export interface OpenAICompatibleOptions {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  excerptChars: number;
  fetchImpl?: FetchLike;
}

export class AIProviderError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'AIProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name = 'openai-compatible';

  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
  }

  static fromConfig(config: AppConfig, fetchImpl?: FetchLike): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      apiKey: config.ai.apiKey,
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      temperature: config.ai.temperature,
      timeoutMs: config.ai.timeoutMs,
      excerptChars: config.aiExcerptChars,
      fetchImpl,
    });
  }

  isAvailable(): boolean {
    // A local endpoint such as Ollama legitimately needs no key.
    return this.options.apiKey !== null || this.options.baseUrl.includes('localhost') || this.options.baseUrl.includes('127.0.0.1');
  }

  health(): ProviderHealth {
    return {
      name: this.name,
      available: this.isAvailable(),
      model: this.isAvailable() ? this.options.model : null,
      detail: this.isAvailable()
        ? `Using ${this.options.model} via ${this.options.baseUrl}`
        : 'No AI_API_KEY configured; the deterministic analyzer is being used.',
    };
  }

  async analyzeEmail(email: NormalizedEmail): Promise<AIVerdict | null> {
    const prompt = buildEmailPrompt(email, this.options.excerptChars);
    return this.complete(prompt.system, prompt.user);
  }

  async analyzeThread(context: ThreadContext): Promise<AIVerdict | null> {
    const prompt = buildThreadPrompt(context, this.options.excerptChars);
    return this.complete(prompt.system, prompt.user);
  }

  /** Single request/response round trip with structured output requested. */
  private async complete(system: string, user: string): Promise<AIVerdict | null> {
    if (!this.isAvailable()) return null;

    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      logger.warn('AI provider unavailable: no fetch implementation');
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetchImpl(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: this.options.temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });

      if (!response.ok) {
        const body = await safeText(response);
        const retryable = response.status === 429 || response.status >= 500;
        logger.warn('AI request failed', {
          status: response.status,
          retryable,
          body: body.slice(0, 200),
        });
        throw new AIProviderError(`AI provider returned ${response.status}`, response.status, retryable);
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        logger.warn('AI response contained no content');
        return null;
      }

      const verdict = parseModelResponse(content);
      if (!verdict) {
        logger.warn('AI response failed validation', { length: content.length });
      }
      return verdict;
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AIProviderError('AI provider timed out', null, true);
      }
      throw new AIProviderError(
        err instanceof Error ? err.message : 'AI provider request failed',
        null,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
