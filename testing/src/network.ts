import { throttling } from 'lighthouse/core/config/constants.js';

/** A link as the edge proxy emulates it, the same way in both directions. */
export interface NetworkProfile {
  readonly rttMs: number;
  readonly kbps: number;
  /** Extra delay per packet, drawn uniformly up to this fraction of the round trip. */
  readonly jitter: number;
  /** An upgraded socket (a WebSocket) is dropped after a lifetime drawn from this range. */
  readonly socketLifetimeMs: readonly [number, number] | undefined;
}

const { mobileSlow4G, mobileRegular3G } = throttling;

/** Every network a project can run on: 4G and 3G are Lighthouse's packet-level mobile profiles;
 *  lossy is slow 4G with jitter and dropped live sockets; wired is not shaped. */
const NETWORKS = {
  wired: undefined,
  '4g': {
    rttMs: mobileSlow4G.rttMs,
    kbps: mobileSlow4G.throughputKbps,
    jitter: 0,
    socketLifetimeMs: undefined,
  },
  '3g': {
    rttMs: mobileRegular3G.rttMs,
    kbps: mobileRegular3G.throughputKbps,
    jitter: 0,
    socketLifetimeMs: undefined,
  },
  lossy: {
    rttMs: mobileSlow4G.rttMs,
    kbps: mobileSlow4G.throughputKbps,
    jitter: 0.5,
    socketLifetimeMs: [5000, 20_000],
  },
} as const satisfies Record<string, NetworkProfile | undefined>;

export type Network = keyof typeof NETWORKS;

/** CPU slowdown per tier: the low end is Lighthouse's mobile reference, applied on Chromium. */
export const CPU_SLOWDOWN = { high: 1, low: mobileSlow4G.cpuSlowdownMultiplier } as const;

export type CpuTier = keyof typeof CPU_SLOWDOWN;

/** The cookie, `<network>.<context id>`, by which the edge knows a browser context or headless
 *  client, shapes its traffic and gives it its own client address. */
export const CONTEXT_COOKIE = 'sites-context';

const PROFILES: ReadonlyMap<string, NetworkProfile | undefined> = new Map(Object.entries(NETWORKS));

export const profileOf = (name: string): NetworkProfile | undefined => PROFILES.get(name);

/** How long moving `bytes` one way takes on this network: its bandwidth and one round trip.
 *  Unshaped (wired) it is no time at all. */
export const transferMs = (network: Network, bytes: number): number => {
  const profile = profileOf(network);
  return profile === undefined ? 0 : (bytes * 8) / profile.kbps + profile.rttMs;
};
