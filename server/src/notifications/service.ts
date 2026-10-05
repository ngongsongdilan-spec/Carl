import { EventEmitter } from 'node:events';
import type { AttentionItem } from '../domain/types.js';
import type { NotificationMode } from '../config/notify.js';

/**
 * The notification boundary.
 *
 * `NotificationService` is an interface plus an event emitter, so the same
 * object serves a browser (over SSE), a desktop client, or a no-op. Swapping in
 * APNs, FCM, or email requires one new implementation.
 *
 * The rules in `shouldNotify` are the product rules: notify only for genuinely
 * new, unhandled, high-signal items -- once, ever.
 */

export interface NotificationPayload {
  itemId: string;
  title: string;
  body: string;
  priority: string;
  category: string;
  deadlineIso: string | null;
  gmailUrl: string;
}

export interface NotificationService {
  notify(payload: NotificationPayload): void;
  shouldNotify(item: AttentionItem, mode: NotificationMode, minConfidence: number): boolean;
  onNotification(listener: (payload: NotificationPayload) => void): () => void;
  /** Marks an item as notified so it is never announced twice. */
  markNotified(itemId: string): void;
  /** Registers a delivery target (log, SSE broadcast, push, ...). */
  addSink(sink: NotificationSink): () => void;
}

export type NotificationSink = (payload: NotificationPayload) => void;

export class EmitterNotificationService implements NotificationService {
  private readonly emitter = new EventEmitter();
  private readonly sinks = new Set<NotificationSink>();
  private readonly notified = new Set<string>();

  constructor(sinks: NotificationSink[] = []) {
    for (const sink of sinks) this.sinks.add(sink);
    this.emitter.setMaxListeners(50);
  }

  addSink(sink: NotificationSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  notify(payload: NotificationPayload): void {
    if (this.notified.has(payload.itemId)) return;
    this.notified.add(payload.itemId);
    this.emitter.emit('notification', payload);
    for (const sink of this.sinks) {
      try {
        sink(payload);
      } catch {
        // A failing notification sink must never fail an analysis run.
      }
    }
  }

  shouldNotify(item: AttentionItem, mode: NotificationMode, minConfidence: number): boolean {
    if (mode === 'off') return false;
    if (item.status !== 'open') return false;
    if (item.notifiedAt !== null) return false;
    if (this.notified.has(item.id)) return false;
    if (item.confidence < minConfidence) return false;
    if (mode === 'high' && item.priority !== 'high') return false;
    return true;
  }

  onNotification(listener: (payload: NotificationPayload) => void): () => void {
    this.emitter.on('notification', listener);
    return () => this.emitter.off('notification', listener);
  }

  markNotified(itemId: string): void {
    this.notified.add(itemId);
  }

  hasNotified(itemId: string): boolean {
    return this.notified.has(itemId);
  }

  /** Seeds known-notified ids from the database after a restart. */
  primeNotified(ids: string[]): void {
    for (const id of ids) this.notified.add(id);
  }
}

/** Human-readable one-liner for the notification body. */
export function buildNotificationBody(item: {
  recommendedAction: string;
  deadlineIso: string | null;
  whyItMatters: string;
}): string {
  const parts: string[] = [];
  if (item.deadlineIso) {
    const when = new Date(item.deadlineIso);
    if (!Number.isNaN(when.getTime())) {
      parts.push(`Due ${when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
    }
  }
  const action = item.recommendedAction || item.whyItMatters;
  if (action) parts.push(action);
  return parts.join(' · ').slice(0, 300);
}
