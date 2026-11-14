import { randomInt } from 'node:crypto';
import type { Socket } from 'node:net';
import type { Transform } from 'node:stream';

import type { NetworkProfile } from '../network.ts';
import type { EdgeContext } from './contexts.ts';

/** How long an ended browser leg is read for the browser's own end, as nginx's lingering_time. */
const LINGER_MS = 30_000;

/** The browser legs already ending, each ended once. */
const lingering = new WeakSet<Socket>();

/** Ends a browser's leg as a proxy's lingering close does, reading what it still sends until it
 *  ends its own: closed under frames on their way, it resets them, an error in Firefox's page. */
export const linger = (client: Socket): void => {
  if (lingering.has(client) || client.destroyed) {
    return;
  }
  lingering.add(client);
  client.unpipe();
  client.resume();
  const bound = setTimeout(() => {
    client.destroy();
  }, LINGER_MS);
  client.once('close', () => {
    clearTimeout(bound);
  });
  client.once('end', () => {
    client.destroy();
  });
  if (!client.writableEnded) {
    client.end();
  }
};

/** The way down into the browser's leg, piped rather than a pipeline: that leg ends by lingering
 *  however the way down ends, and its close takes the way down, and the upstream leg with it. */
export const pipeDown = (down: Transform, client: Socket): void => {
  down.pipe(client);
  down.once('close', () => {
    linger(client);
  });
  client.once('close', () => {
    down.destroy();
  });
};

const lifetimeOf = (profile: NetworkProfile | undefined): NetworkProfile['socketLifetimeMs'] =>
  profile === undefined ? undefined : profile.socketLifetimeMs;

/** Holds an upgraded connection as its context's live one. A lossy profile drops it after a
 *  lifetime drawn from it, the emulated fault: the upstream leg cut, and the browser's ended. */
export const hold = (client: Socket, upstream: Socket, context: EdgeContext | undefined): void => {
  if (context === undefined) {
    return;
  }
  const lifetime = lifetimeOf(context.down.profile);
  const drop = (): void => {
    context.live.delete(drop);
    linger(client);
    upstream.destroy();
  };
  const timer = lifetime === undefined ? undefined : setTimeout(drop, randomInt(...lifetime));
  context.live.add(drop);
  for (const socket of [client, upstream]) {
    socket.once('close', () => {
      clearTimeout(timer);
      context.live.delete(drop);
    });
  }
};
