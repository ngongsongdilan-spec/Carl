import type { AppConfig } from '../config/env.js';
import { HeuristicProvider } from './heuristic.js';
import { OpenAICompatibleProvider, type FetchLike } from './openaiCompatible.js';
import type { AIProvider, ProviderHealth } from './provider.js';

/**
 * Provider selection.
 *
 * One place decides which provider the app runs with, based on configuration
 * only. Swapping in a different vendor means adding a branch here and nothing
 * else.
 */
export function createAIProvider(config: AppConfig, fetchImpl?: FetchLike): AIProvider {
  if (config.ai.mode === 'off') {
    return new HeuristicProvider('AI disabled (AI_MODE=off). Rules only.');
  }

  const provider = OpenAICompatibleProvider.fromConfig(config, fetchImpl);

  if (provider.isAvailable()) return provider;

  if (config.ai.mode === 'ai') {
    // The caller asked for AI and there is none. Return a provider that is
    // unavailable so the pipeline can report "AI analysis is temporarily
    // unavailable" instead of silently pretending AI ran.
    return new HeuristicProvider(
      'AI_MODE=ai but no AI_API_KEY or local endpoint is configured.',
    );
  }

  return new HeuristicProvider('No AI_API_KEY configured. Deterministic analyzer in use.');
}

export function describeProvider(provider: AIProvider): ProviderHealth {
  if (provider instanceof OpenAICompatibleProvider) return provider.health();
  if (provider instanceof HeuristicProvider) return provider.health();
  return { name: provider.name, available: provider.isAvailable(), model: null, detail: '' };
}

export type { AIProvider, ProviderHealth };
