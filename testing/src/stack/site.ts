// One target's stack started from Node, outside Playwright, as a member of the machine's CPU gate:
// while it builds, or, for gated work, for its whole life, as a run is.
import { discover } from '../discover.ts';
import { holdTurn } from './control.ts';
import { joinGate, type Membership } from './gate-member.ts';
import { type Coordinates, startTarget } from './stack.ts';
import { trustCa } from './tls.ts';

export interface Site {
  readonly coordinates: Coordinates;
  /** Stops every service in reverse order of starting. */
  readonly stop: () => Promise<void>;
}

export interface GatedSite extends Site {
  /** Waits for one of the gate's slots; held until released. */
  readonly cpuTurn: () => Promise<() => void>;
}

/** An abort leaves `gate`. Once started, this process's own clients (fetch, WebSocket) trust the
 *  target's edge too. */
const started = async (
  name: string,
  gate: Membership,
  { signal, publicOrigin }: { signal: AbortSignal; publicOrigin?: string | undefined },
): Promise<Site> => {
  const target = discover().find((found) => found.name === name);
  if (target === undefined) {
    throw new Error(`no target is named ${name}`);
  }
  signal.addEventListener('abort', gate.leave, { once: true });
  try {
    const { coordinates, stop } = await startTarget(target, {
      signal,
      turns: gate.turns,
      publicOrigin,
    });
    trustCa(coordinates.trust.ca);
    return { coordinates, stop };
  } catch (error) {
    gate.leave();
    throw error;
  }
};

/** Builds and starts the target named `name`, then leaves the gate; `admitted` runs as it starts. */
export const startSite = async (
  name: string,
  signal: AbortSignal,
  admitted?: () => void,
): Promise<Site> => {
  const gate = await joinGate();
  if (admitted !== undefined) {
    admitted();
  }
  const site = await started(name, gate, { signal });
  gate.leave();
  return site;
};

/** Starts the target named `name` as a run does, a member of the CPU gate from start to stop, its
 *  work paced by turns; a public origin makes the backend answer as that origin. */
export const startGatedSite = async (
  name: string,
  signal: AbortSignal,
  publicOrigin?: string,
): Promise<GatedSite> => {
  const gate = await joinGate();
  const { coordinates, stop } = await started(name, gate, { signal, publicOrigin });
  return {
    coordinates,
    stop: async () => {
      try {
        await stop();
      } finally {
        gate.leave();
      }
    },
    cpuTurn: async () => holdTurn(gate.turns),
  };
};
