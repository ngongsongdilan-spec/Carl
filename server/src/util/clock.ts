/**
 * Injected clock.
 *
 * Deadlines and "has this passed yet" decisions are time-dependent. Tests must
 * control time; production code must not call `Date.now()` directly.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const fixed = new Date(iso).getTime();
  return { now: () => new Date(fixed) };
}

export class AdvancingClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}
