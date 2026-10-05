import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/database.js';
import type { MailProvider } from '../mail/provider.js';
import type { AIProvider } from '../ai/provider.js';
import { logger } from '../logging/logger.js';
import type { Clock } from '../util/clock.js';
import type { EmailClient } from '../ai/chatClient.js';

/**
 * The scoped assistant.
 *
 * Hard scope: it may only answer questions about the user's own detected
 * attention items. Two mechanisms enforce that:
 *
 *   1. A deterministic intent router answers the six supported question shapes
 *      directly from the database. No model call, instant answer, no chance of
 *      invention.
 *   2. If a model is configured, it is used only to phrase the answer, with the
 *      item list as its entire context, and it is instructed to refuse anything
 *      out of scope.
 *
 * There is deliberately no general chat path.
 */

export interface AssistantDeps {
  config: AppConfig;
  db: Database;
  clock: Clock;
  mail: MailProvider;
  chat?: EmailClient | null;
}

export interface AssistantAnswer {
  answer: string;
  /** Items the answer was derived from. */
  citedItemIds: string[];
  /** Which path answered it. */
  source: 'intent' | 'model' | 'intent+model';
  outOfScope: boolean;
}

const OUT_OF_SCOPE_PATTERNS = [
  /\b(write|generate|create|debug|refactor)\b.*\b(code|function|script|class|regex|sql)\b/i,
  /\b(weather|stock price|recipe|joke|sports score|news about|translate)\b/i,
  /\b(who are you|what can you do|your name)\b/i,
];

export function isOutOfScope(question: string): boolean {
  const q = question.trim();
  if (q.length < 3) return true;
  if (/^(?:hi|hey|hello|thanks|thank you|ok|okay|yes|no)\b/i.test(q)) return true;
  return OUT_OF_SCOPE_PATTERNS.some((p) => p.test(q));
}

interface Intent {
  name:
    | 'what_needs_attention'
    | 'most_urgent'
    | 'why_matters'
    | 'what_to_do'
    | 'show_source'
    | 'deadlines'
    | 'unknown';
}

export function classifyIntent(question: string): Intent {
  const q = question.toLowerCase();

  if (/\b(most urgent|top priority|biggest|most important|urgent|first)\b/.test(q)) {
    return { name: 'most_urgent' };
  }
  if (/\b(when|deadline|due|by when|what date|expires?)\b/.test(q) && !/^why/.test(q)) {
    return { name: 'deadlines' };
  }
  if (/\b(why|reason|important|significance|matters|consequence)\b/.test(q)) {
    return { name: 'why_matters' };
  }
  if (/\b(what (should )?(i )?do|action|next step|how do i|what do i need)\b/.test(q)) {
    return { name: 'what_to_do' };
  }
  if (/\b(show|open|original|source|email this|where.*from|link)\b/.test(q)) {
    return { name: 'show_source' };
  }
  if (/\b(attention|needs? (my|your)|pending|outstanding|unresolved|what'?s up|todo|to-do)\b/.test(q)) {
    return { name: 'what_needs_attention' };
  }
  return { name: 'unknown' };
}

const PRIORITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export class Assistant {
  constructor(private readonly deps: AssistantDeps) {}

  async ask(question: string): Promise<AssistantAnswer> {
    const q = question.trim();

    if (isOutOfScope(q)) {
      return {
        answer:
          'I can only answer questions about your attention items - for example "What needs my attention?", "What is the most urgent thing?", "Why is this important?", or "Show me the email this came from."',
        citedItemIds: [],
        source: 'intent',
        outOfScope: true,
      };
    }

    const intent = classifyIntent(q);
    const base = this.answerFromIntent(intent, q);

    if (this.deps.config.ai.mode === 'off' || !this.deps.chat) {
      return base;
    }

    // Phrase the deterministic answer with the model, without letting the model
    // change which items are cited or invent new facts.
    const improved = await this.rephrase(q, base);
    if (improved) {
      return { ...base, answer: improved, source: 'intent+model' };
    }
    return base;
  }

  /** Deterministic answer built entirely from stored items. */
  private answerFromIntent(intent: Intent, question: string): AssistantAnswer {
    const items = this.openItems();

    if (items.length === 0) {
      return {
        answer: 'Nothing needs your attention right now.',
        citedItemIds: [],
        source: 'intent',
        outOfScope: false,
      };
    }

    const cited = items.map((i) => i.id);

    switch (intent.name) {
      case 'most_urgent': {
        const top = this.sorted()[0];
        return {
          answer: [
            `The most urgent thing is: ${top.title}.`,
            top.deadlineIso ? `Deadline: ${this.formatDate(top.deadlineIso)}.` : 'No deadline detected.',
            `Why it matters: ${top.whyItMatters}`,
            `Action: ${top.recommendedAction}`,
          ].join('\n\n'),
          citedItemIds: [top.id],
          source: 'intent',
          outOfScope: false,
        };
      }

      case 'why_matters': {
        const target = this.findByTitle(question) ?? this.sorted()[0];
        return {
          answer: `${target.title}\n\nWhy it matters: ${target.whyItMatters}\n\n${target.summary}`,
          citedItemIds: [target.id],
          source: 'intent',
          outOfScope: false,
        };
      }

      case 'what_to_do': {
        const target = this.findByTitle(question) ?? this.sorted()[0];
        return {
          answer: [
            `For "${target.title}":`,
            target.recommendedAction,
            target.deadlineIso
              ? `Do this by ${this.formatDate(target.deadlineIso)}.`
              : 'No deadline was detected in the email.',
          ].join('\n\n'),
          citedItemIds: [target.id],
          source: 'intent',
          outOfScope: false,
        };
      }

      case 'show_source': {
        const target = this.findByTitle(question) ?? this.sorted()[0];
        return {
          answer: `"${target.title}" came from ${target.sourceSender ?? 'an unknown sender'}.\n\nSubject: ${target.sourceSubject ?? '(no subject)'}\n\n${target.sourceExcerpt || '(no preview available)'}\n\nOpen the original: ${this.deps.mail.getMessageUrl(target.sourceMessageId)}`,
          citedItemIds: [target.id],
          source: 'intent',
          outOfScope: false,
        };
      }

      case 'deadlines': {
        const withDeadlines = this.sorted().filter((i) => i.deadlineIso !== null);
        if (withDeadlines.length === 0) {
          return {
            answer: 'None of your current attention items have a deadline.',
            citedItemIds: cited,
            source: 'intent',
            outOfScope: false,
          };
        }
        return {
          answer: withDeadlines
            .map((i) => `• ${i.title} — due ${this.formatDate(i.deadlineIso as string)}`)
            .join('\n'),
          citedItemIds: withDeadlines.map((i) => i.id),
          source: 'intent',
          outOfScope: false,
        };
      }

      case 'what_needs_attention':
      case 'unknown':
      default: {
        const list = this.sorted();
        const lines = list.map((i, index) => {
          const deadline = i.deadlineIso ? ` — due ${this.formatDate(i.deadlineIso)}` : '';
          return `${index + 1}. ${i.title} (${i.priority})${deadline}`;
        });
        const high = list.filter((i) => i.priority === 'high').length;
        return {
          answer: [
            `${list.length} item${list.length === 1 ? '' : 's'} need your attention${high > 0 ? `, ${high} high priority` : ''}:`,
            '',
            ...lines,
            '',
            `Ask "why is ${list[0].title} important" or "what should I do" for detail.`,
          ].join('\n'),
          citedItemIds: cited,
          source: 'intent',
          outOfScope: false,
        };
      }
    }
  }

  /** Optional model pass used only to improve phrasing. Never changes facts. */
  private async rephrase(question: string, base: AssistantAnswer): Promise<string | null> {
    const chat = this.deps.chat;
    if (!chat) return null;

    try {
      const reply = await chat.complete(
        'You rephrase answers about a person\'s attention items. Keep every fact exactly as given. Never add an item, a date, or an instruction that is not present. If asked anything outside attention items, reply exactly: "I can only answer questions about your attention items." Be concise.',
        [
          `Question: ${question}`,
          `Verified facts to use (do not contradict or extend):\n${base.answer}`,
          'Rephrase the facts above into a direct answer.',
        ].join('\n\n'),
      );
      if (!reply) return null;
      const trimmed = reply.trim();
      if (trimmed.length === 0 || trimmed.length > 1200) return null;
      return trimmed;
    } catch (err) {
      logger.debug('Assistant rephrase failed; using deterministic answer', {
        message: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      });
      return null;
    }
  }

  private openItems(): AssistantItem[] {
    const items = this.deps.db
      .all<Record<string, unknown>>(
        `SELECT i.*, m.from_addr, m.from_name, m.subject, m.body_excerpt
         FROM items i
         LEFT JOIN messages m ON m.gmail_id = i.source_message_id
         WHERE i.status = 'open'
         ORDER BY CASE i.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                  i.confidence DESC,
                  COALESCE(i.deadline_iso, '9999') ASC`,
      )
      .map((row) => ({
        id: String(row.id),
        confidenceHint: Number(row.confidence ?? 0),
        title: String(row.title ?? ''),
        summary: String(row.summary ?? ''),
        whyItMatters: String(row.why ?? ''),
        recommendedAction: String(row.action ?? ''),
        priority: String(row.priority ?? 'low'),
        deadlineIso: row.deadline_iso ? String(row.deadline_iso) : null,
        sourceMessageId: String(row.source_message_id ?? ''),
        sourceSender:
          (row.from_name ? String(row.from_name) : null) ??
          (row.from_addr ? String(row.from_addr) : null),
        sourceSubject: row.subject ? String(row.subject) : null,
        sourceExcerpt: row.body_excerpt ? String(row.body_excerpt) : null,
      }));

    return items;
  }

  private sorted(): AssistantItem[] {
    return this.openItems().sort((a, b) => {
      const rank = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
      if (rank !== 0) return rank;
      if (a.deadlineIso && b.deadlineIso) return a.deadlineIso.localeCompare(b.deadlineIso);
      if (a.deadlineIso) return -1;
      if (b.deadlineIso) return 1;
      return b.confidenceHint - a.confidenceHint;
    });
  }

  private findByTitle(question: string): AssistantItem | null {
    const q = question.toLowerCase();
    const items = this.openItems();
    let best: AssistantItem | null = null;
    let bestScore = 0;
    for (const item of items) {
      const words = item.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const score = words.filter((w) => q.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  private formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

interface AssistantItem {
  id: string;
  title: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  priority: string;
  deadlineIso: string | null;
  sourceMessageId: string;
  sourceSender: string | null;
  sourceSubject: string | null;
  sourceExcerpt: string | null;
  confidenceHint: number;
}

