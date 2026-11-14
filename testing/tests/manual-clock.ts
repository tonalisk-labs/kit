// A clock for tests that moves only when told, so a bound on stillness is read without waiting.
import type { Clock } from '../src/stack/stall.ts';

/** A clock that moves only when told, ringing each alarm it passes. */
export const manualClock = (): {
  readonly clock: Clock;
  readonly advance: (ms: number) => void;
} => {
  const state = { now: 0, alarms: new Set<{ readonly at: number; readonly ring: () => void }>() };
  return {
    clock: {
      now: () => state.now,
      after: (ms, ring) => {
        const alarm = { at: state.now + ms, ring };
        state.alarms.add(alarm);
        return () => {
          state.alarms.delete(alarm);
        };
      },
    },
    // Rings every alarm due by then, those its rings set among them, in the order they fall due.
    advance: (ms) => {
      state.now += ms;
      const due = (): { readonly at: number; readonly ring: () => void } | undefined =>
        [...state.alarms]
          .filter(({ at }) => at <= state.now)
          .toSorted((one, other) => one.at - other.at)[0];
      for (let alarm = due(); alarm !== undefined; alarm = due()) {
        state.alarms.delete(alarm);
        alarm.ring();
      }
    },
  };
};
