/** Formatting helpers. Pure, so they are trivial to reason about in review. */

/** Hours until an ISO timestamp; negative means it has passed, null if unparseable. */
export function hoursUntil(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (t - Date.now()) / 3_600_000;
}

/**
 * Deadlines inside 48 hours get relative phrasing because that is the range
 * where the number matters more than the date.
 */
export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const hours = hoursUntil(iso);
  if (hours !== null && hours >= 0 && hours < 48) {
    if (hours < 1) return 'Due in under an hour';
    if (hours < 24) return `Due in ${Math.round(hours)} hours`;
    const days = Math.round(hours / 24);
    return `Due in ${days} day${days === 1 ? '' : 's'}`;
  }

  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatReceived(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const diff = Date.now() - d.getTime();
  const hours = diff / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  if (hours < 24 * 7) return `${Math.round(hours / 24)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
