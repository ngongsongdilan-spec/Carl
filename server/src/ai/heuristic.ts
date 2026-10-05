import type { AIVerdict, NormalizedEmail, ThreadContext } from '../domain/types.js';
import type { AIProvider, ProviderHealth } from './provider.js';

/**
 * The no-AI provider.
 *
 * Present so that `AI_MODE=off` follows exactly the same code path as any other
 * mode -- it simply declines to contribute anything, and the deterministic
 * engine carries the whole decision. Also used as the safety net when a remote
 * provider errors, which is what keeps a provider outage from turning into an
 * application outage.
 */
export class HeuristicProvider implements AIProvider {
  readonly name = 'deterministic';

  private readonly reason: string;

  constructor(reason = 'Deterministic analyzer only (AI disabled).') {
    this.reason = reason;
  }

  isAvailable(): boolean {
    // Always "available" -- being deterministic is the point. It just has
    // nothing to contribute.
    return true;
  }

  health(): ProviderHealth {
    return { name: this.name, available: true, model: null, detail: this.reason };
  }

  async analyzeEmail(_email: NormalizedEmail): Promise<AIVerdict | null> {
    return null;
  }

  async analyzeThread(_context: ThreadContext): Promise<AIVerdict | null> {
    return null;
  }
}
