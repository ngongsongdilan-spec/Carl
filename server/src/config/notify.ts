import type { NotifyMode } from './env.js';

export type NotificationMode = 'off' | 'high' | 'all';

export function toNotificationMode(value: NotifyMode | string): NotificationMode {
  return value === 'off' ? 'off' : value === 'all' ? 'all' : 'high';
}
