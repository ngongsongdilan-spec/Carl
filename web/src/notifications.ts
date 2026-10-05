/**
 * Notifications.
 *
 * The server emits over SSE while the app is open; this module turns those
 * events into browser notifications. Two deliberate constraints:
 *
 *   - a notification is only ever shown for a genuinely new, high-signal item
 *   - a duplicate is never shown, tracked per item id in this session
 */

import type { NotificationPayload } from './types';

const seen = new Set<string>();

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Shows a notification at most once per item id per session. */
export function showNotification(payload: NotificationPayload): boolean {
  if (seen.has(payload.itemId)) return false;
  seen.add(payload.itemId);

  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  // A document that is already visible does not need interrupting.
  if (document.visibilityState === 'visible') return false;

  try {
    const n = new Notification(payload.title, {
      body: payload.body,
      tag: `attention-${payload.itemId}`,
      requireInteraction: payload.priority === 'high',
    });
    n.onclick = () => {
      window.focus();
      // Only navigate when the payload URL is a mail.google.com link we built.
      if (payload.gmailUrl.startsWith('https://mail.google.com/')) {
        window.open(payload.gmailUrl, '_blank', 'noopener,noreferrer');
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * Subscribes to the server event stream.
 * Returns a cleanup function. Reconnection is handled by EventSource itself.
 */
export function subscribeToNotifications(
  onNotification: (payload: NotificationPayload) => void,
  onStatusChange?: (connected: boolean) => void,
): () => void {
  let source: EventSource | null = null;
  let closed = false;

  const connect = (): void => {
    source = new EventSource('/api/stream');

    source.addEventListener('ready', () => onStatusChange?.(true));

    source.addEventListener('notification', (event) => {
      const message = event as MessageEvent<string>;
      try {
        const parsed: unknown = JSON.parse(message.data);
        if (parsed && typeof parsed === 'object') onNotification(parsed as NotificationPayload);
      } catch {
        // A malformed event must not break the stream.
      }
    });

    source.onerror = () => {
      onStatusChange?.(false);
      // EventSource reconnects on its own unless we close it.
      if (closed) return;
    };
  };

  connect();

  return () => {
    closed = true;
    source?.close();
  };
}
