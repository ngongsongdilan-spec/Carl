import type {
  AIVerdict,
  AttentionCategory,
  DeadlineDraft,
  NormalizedEmail,
  Priority,
  ThreadContext,
} from '../domain/types.js';
import { partitionBySignal, type PrefilterResult } from './prefilter.js';
import { extractSignals } from './signals.js';
import { signalText } from '../mail/normalize.js';
import { extractDeadline } from './deadlines.js';
import { buildThreadContext, groupIntoThreads, threadText } from './threader.js';
import { resolveSuppression } from './resolve.js';
import {
  buildDeterministicVerdict,
  countIndependentSignals,
  mergeVerdicts,
} from './verdict.js';
import { eventKeyFor } from './dedupe.js';
import type { AIProvider } from '../ai/provider.js';
import type { Clock } from '../util/clock.js';
import { AIProviderError } from '../ai/openaiCompatible.js';
import { logger } from '../logging/logger.js';

/**
 * The attention engine.
 *
 * One entry point, `analyze()`, takes messages and returns a full audit of what
 * was decided and why. It is a pure-ish function: it reads nothing from the
 * database, makes no network calls except through the injected AI provider, and
 * depends on an injected clock. That is what makes it exhaustively testable.
 */

export interface EngineOptions {
  aiProvider: AIProvider;
  clock: Clock;
  minConfidence: number;
  aiMode: 'off' | 'hybrid' | 'ai';
  aiMaxCalls?: number;
  userAddress?: string | null;
  onProgress?: (progress: EngineProgress) => void;
}

export interface EngineProgress {
  stage: 'prefilter' | 'rules' | 'ai' | 'done';
  processed: number;
  total: number;
}

export interface EngineItem {
  eventKey: string;
  threadId: string | null;
  sourceMessageId: string;
  sourceThreadId: string | null;
  category: AttentionCategory;
  priority: Priority;
  confidence: number;
  title: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  deadline: DeadlineDraft;
  decidedBy: 'rules' | 'ai' | 'hybrid';
}

export interface SuppressedItem {
  messageId: string;
  threadId: string | null;
  category: AttentionCategory;
  reason: string;
  detail: string;
  confidence: number;
}

export interface EngineResult {
  items: EngineItem[];
  suppressed: SuppressedItem[];
  stats: {
    total: number;
    prefilteredNoise: number;
    threads: number;
    aiCalls: number;
    aiFailures: number;
    degraded: boolean;
  };
}

export interface AnalyzeInput {
  messages: NormalizedEmail[];
  /** Already-persisted items, used for cross-run duplicate suppression. */
  existingItems?: { eventKey: string; category: string; subject: string; createdAt: string; threadId: string | null }[];
}

export class AttentionEngine {
  private readonly options: EngineOptions;

  constructor(options: EngineOptions) {
    this.options = options;
  }

  async analyze(input: AnalyzeInput): Promise<EngineResult> {
    const { messages } = input;
    const now = this.options.clock.now();

    const items: EngineItem[] = [];
    const suppressed: SuppressedItem[] = [];
    let aiCalls = 0;
    let aiFailures = 0;
    let degraded = false;

    // ---- stage 1+2: prefilter -----------------------------------------
    const { analyze: candidates, skipped } = partitionBySignal(messages);
    for (const { email, result } of skipped) {
      suppressed.push({
        messageId: email.id,
        threadId: email.threadId,
        category: (result.category ?? 'informational') as AttentionCategory,
        reason: 'noise',
        detail: noiseDetail(result),
        confidence: result.confidence,
      });
    }

    // ---- stage 3: thread assembly -------------------------------------
    const threadGroups = groupIntoThreads(candidates);
    const threads = [...threadGroups.entries()].map(([threadId, msgs]) =>
      buildThreadContext(threadId, msgs, this.options.userAddress),
    );

    const maxCalls = this.options.aiMaxCalls ?? Number.POSITIVE_INFINITY;
    let processed = 0;

    for (const context of threads) {
      const email = context.latest;
      const signals = extractSignals(email);
      // The newest message is the live state of the situation, so its dates are
      // searched first. Scanning the whole thread top-down would pick up a date
      // from an *earlier* message that the newest one has since superseded -- a
      // reschedule that mentions both the cancelled slot and the new one would
      // resolve to the cancelled one.
      const latestDates = extractDeadline(signalText(email), email.date);
      const wholeThread = latestDates.deadline.iso
        ? { deadline: latestDates.deadline, vagueDeadlineLanguage: latestDates.vagueDeadlineLanguage }
        : extractDeadline(threadText(context), email.date);
      const { deadline, vagueDeadlineLanguage } = wholeThread;

      processed += 1;
      this.options.onProgress?.({
        stage: 'rules',
        processed,
        total: threads.length,
      });

      // ---- stage 5: suppression checks ------------------------------
      const suppression = resolveSuppression({
        context,
        signals,
        deadlineIso: deadline.iso,
        deadlineRaw: deadline.raw,
        now,
        userAddress: this.options.userAddress,
      });

      // ---- stage 4: rules verdict ------------------------------------
      const rules = buildDeterministicVerdict({
        email,
        context,
        threadText: threadText(context),
        signals,
        deadline,
        now,
      });

      if (suppression) {
        suppressed.push({
          messageId: email.id,
          threadId: context.threadId,
          category: rules.category,
          reason: suppression.reason,
          detail: suppression.detail,
          confidence: rules.confidence,
        });
        continue;
      }

      if (!rules.isAttentionItem) {
        suppressed.push({
          messageId: email.id,
          threadId: context.threadId,
          category: rules.category,
          reason: vagueDeadlineLanguage ? 'no_action_required' : 'below_threshold',
          detail:
            rules.suppressionReason ??
            'No actionable request, obligation, or deadline detected.',
          confidence: rules.confidence,
        });
        continue;
      }

      // ---- stage 6: AI refinement (only where it can help) ------------
      let aiVerdict: AIVerdict | null = null;
      const independentSignals = countIndependentSignals(signals);
      const shouldCallAi =
        this.options.aiMode !== 'off' &&
        aiCalls < maxCalls &&
        needsAi(signals, rules.confidence, this.options.minConfidence);

      if (shouldCallAi) {
        aiCalls += 1;
        this.options.onProgress?.({ stage: 'ai', processed, total: threads.length });
        try {
          aiVerdict =
            context.messages.length > 1
              ? await this.options.aiProvider.analyzeThread(context)
              : await this.options.aiProvider.analyzeEmail(email);
          if (aiVerdict === null && this.options.aiMode === 'ai') degraded = true;
        } catch (err) {
          aiFailures += 1;
          degraded = true;
          logger.warn('AI analysis failed; falling back to rules', {
            message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
            retryable: err instanceof AIProviderError ? err.retryable : true,
          });
        }
      }

      const aiAgrees =
        aiVerdict !== null &&
        aiVerdict.isAttentionItem === true &&
        aiVerdict.category === rules.category;
      const aiDisagrees =
        aiVerdict !== null &&
        (aiVerdict.isAttentionItem !== rules.isAttentionItem ||
          aiVerdict.category !== rules.category);

      const merged = mergeVerdicts({
        rules,
        ai: aiVerdict,
        aiAgrees,
        aiDisagrees,
        independentSignals,
      });

      if (!merged.isAttentionItem) {
        suppressed.push({
          messageId: email.id,
          threadId: context.threadId,
          category: rules.category,
          reason: 'below_threshold',
          detail: 'The AI review judged this as not requiring attention.',
          confidence: merged.confidence,
        });
        continue;
      }

      if (merged.confidence < this.options.minConfidence) {
        suppressed.push({
          messageId: email.id,
          threadId: context.threadId,
          category: merged.category,
          reason: 'low_confidence',
          detail: `Confidence ${merged.confidence.toFixed(2)} is below the ${this.options.minConfidence} threshold.`,
          confidence: merged.confidence,
        });
        continue;
      }

      const eventKey = eventKeyFor({
        category: merged.category,
        subject: email.subject,
        bodyText: email.bodyText,
        date: email.date,
        threadId: context.threadId,
      });

      items.push({
        eventKey,
        threadId: context.threadId,
        sourceMessageId: email.id,
        sourceThreadId: context.threadId,
        category: merged.category,
        priority: merged.priority,
        confidence: merged.confidence,
        title: merged.title,
        summary: merged.summary,
        whyItMatters: merged.whyItMatters,
        recommendedAction: merged.recommendedAction,
        deadline: merged.deadline,
        decidedBy: aiVerdict ? 'hybrid' : 'rules',
      });
    }

    // ---- stage 7: dedupe within this run ------------------------------
    const deduped = dedupeWithinRun(items);
    const filtered: DedupeResult = input.existingItems
      ? dedupeAgainstExisting(deduped, input.existingItems)
      : { kept: deduped, duplicates: [] };

    for (const dup of filtered.duplicates) {
      suppressed.push({
        messageId: dup.sourceMessageId,
        threadId: dup.threadId,
        category: dup.category,
        reason: 'duplicate',
        detail: 'Already covered by an existing attention item.',
        confidence: dup.confidence,
      });
    }

    this.options.onProgress?.({
      stage: 'done',
      processed: threads.length,
      total: threads.length,
    });

    return {
      items: filtered.kept,
      suppressed,
      stats: {
        total: messages.length,
        prefilteredNoise: skipped.length,
        threads: threads.length,
        aiCalls,
        aiFailures,
        degraded,
      },
    };
  }
}

/**
 * Whether the AI is worth calling for this item.
 *
 * The engine calls the model for genuinely uncertain cases only: items close to
 * the confidence threshold, items with a strong obligation but no deadline, or
 * items where wording quality will drive a user decision. Clear-cut high
 * confidence items skip it, which is the main reason a 100-message run costs a
 * handful of calls rather than 100.
 */
export function needsAi(
  signals: ReturnType<typeof extractSignals>,
  rulesConfidence: number,
  minConfidence: number,
): boolean {
  const hasObligation = signals.some(
    (s) =>
      s.kind === 'action_request' ||
      s.kind === 'obligation' ||
      s.kind === 'security' ||
      s.kind === 'consequence',
  );
  if (!hasObligation) return false;

  const nearThreshold = Math.abs(rulesConfidence - minConfidence) < 0.2;
  const uncertain = rulesConfidence < 0.75;
  return nearThreshold || uncertain;
}

function noiseDetail(result: PrefilterResult): string {
  const reasons = result.reasons.filter((r) => r !== 'weak evidence');
  return reasons.length > 0
    ? `Filtered as ${result.category ?? 'noise'}: ${reasons.join(', ')}.`
    : 'Filtered as non-actionable.';
}

/** Collapses items from the same thread/event within a single run. */
export function dedupeWithinRun(items: EngineItem[]): EngineItem[] {
  const byKey = new Map<string, EngineItem>();
  for (const item of items) {
    const existing = byKey.get(item.eventKey);
    if (!existing) {
      byKey.set(item.eventKey, item);
      continue;
    }
    // Keep the stronger of two duplicates.
    const keep =
      item.confidence > existing.confidence ||
      (item.confidence === existing.confidence && item.priority === 'high');
    if (keep) byKey.set(item.eventKey, item);
  }
  return [...byKey.values()].sort(
    (a, b) => b.confidence - a.confidence || priorityRank(b.priority) - priorityRank(a.priority),
  );
}

function priorityRank(p: Priority): number {
  return p === 'high' ? 3 : p === 'medium' ? 2 : 1;
}

export interface DedupeResult {
  kept: EngineItem[];
  duplicates: EngineItem[];
}

interface ExistingLike {
  eventKey: string;
  category: string;
  subject: string;
  createdAt: string;
  threadId: string | null;
}

function dedupeAgainstExisting(items: EngineItem[], existing: ExistingLike[]): DedupeResult {
  const kept: EngineItem[] = [];
  const duplicates: EngineItem[] = [];
  for (const item of items) {
    const clash = existing.find((e) => {
      if (e.eventKey === item.eventKey) return true;
      if (e.threadId && item.threadId && e.threadId === item.threadId) return true;
      if (e.category !== item.category) return false;
      return (
        e.subject.toLowerCase().slice(0, 40) === item.title.toLowerCase().slice(0, 40) &&
        e.subject.length > 8
      );
    });
    if (clash) duplicates.push(item);
    else kept.push(item);
  }
  return { kept, duplicates };
}
