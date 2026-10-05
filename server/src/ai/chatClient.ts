import type { AppConfig } from '../config/env.js';
import { logger } from '../logging/logger.js';

/**
 * A minimal text-completion client, separate from the verdict provider.
 *
 * The attention engine needs structured JSON with validation. The assistant
 * needs plain prose. Keeping them apart means a failure in one cannot affect
 * the other, and each can be disabled independently.
 */
export interface EmailClient {
  readonly name: string;
  isAvailable(): boolean;
  complete(system: string, user: string): Promise<string | null>;
}

export class ChatClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatClientError';
  }
}

export interface ChatClientOptions {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class OpenAIChatClient implements EmailClient {
  readonly name = 'openai-chat';

  constructor(private readonly options: ChatClientOptions) {}

  static fromConfig(config: AppConfig, fetchImpl?: typeof fetch): OpenAIChatClient | null {
    if (config.ai.mode === 'off' || !config.ai.apiKey) return null;
    return new OpenAIChatClient({
      apiKey: config.ai.apiKey,
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      temperature: config.ai.temperature,
      timeoutMs: config.ai.timeoutMs,
      fetchImpl,
    });
  }

  isAvailable(): boolean {
    return this.options.apiKey !== null || this.options.baseUrl.includes('localhost');
  }

  async complete(system: string, user: string): Promise<string | null> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl || !this.isAvailable()) return null;

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
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });

      if (!response.ok) {
        logger.warn('Chat completion failed', { status: response.status });
        throw new ChatClientError(`Chat provider returned ${response.status}`);
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = payload?.choices?.[0]?.message?.content;
      return typeof content === 'string' && content.trim().length > 0 ? content : null;
    } catch (err) {
      if (err instanceof ChatClientError) throw err;
      throw new ChatClientError(
        err instanceof Error ? err.message.slice(0, 200) : 'chat request failed',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
