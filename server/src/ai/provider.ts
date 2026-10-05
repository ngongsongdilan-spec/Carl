import type { AIVerdict, NormalizedEmail, ThreadContext } from '../domain/types.js';

/**
 * The AI boundary.
 *
 * Everything above this interface is provider-agnostic. Adding Anthropic,
 * Gemini, or a local model means writing one new class -- no change to the
 * pipeline, the engine, or the API.
 */
export interface AIProvider {
  /** Stable identifier shown in the UI. */
  readonly name: string;
  /** False when the provider cannot currently serve requests. */
  isAvailable(): boolean;
  /** Analyzes a single message in isolation. */
  analyzeEmail(email: NormalizedEmail): Promise<AIVerdict | null>;
  /** Analyzes a whole thread with full context. Preferred when available. */
  analyzeThread(context: ThreadContext): Promise<AIVerdict | null>;
}

export interface ProviderHealth {
  name: string;
  available: boolean;
  model: string | null;
  detail: string;
}
