import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  type ClientRequest,
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  answerDeadline,
  answerHolders,
  GATE_MARK,
  GATE_PORT,
  GATE_SCRIPT,
  GATE_VERSION,
  deadlineOf,
  holderOf,
  holdIdOf,
  holdOpen,
  LAUNCH,
  SERVES,
  TAKEN,
  WHOLE,
} from './gate-server.ts';
import { type HoldKind, openHold, statusOf } from './hold.ts';

/** A run's place at the machine's one CPU gate (stack/gate-server.ts). */
export interface Membership {
  /** The URL its tests open to hold a CPU turn. */
  readonly turns: string;
  /** Leaves the gate, which refuses the run's waiting turns and any later one. */
  readonly leave: () => void;
}

/** A gate not there, or closing as the join reaches it (refused, reset, or EPIPE mid-write): each
 *  is answered by starting a gate, as a gate closes its port as it stops. */
export const isAbsent = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.code === 'EPIPE');

const responseTo = async (call: ClientRequest): Promise<IncomingMessage> => {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  call.once('response', resolve).once('error', reject);
  return promise;
};

/** A join the gate answered: open while the run is a member. */
type Joined = ClientRequest;

const tryJoin = async (origin: string, run: string): Promise<Joined | undefined> => {
  const call = request(`${origin}/join/${run}`, { method: 'POST' });
  call.flushHeaders();
  const [answer] = await Promise.allSettled([responseTo(call)]);
  if (answer.status === 'rejected') {
    if (isAbsent(answer.reason)) {
      return undefined;
    }
    throw answer.reason;
  }
  const mark = answer.value.headers[GATE_MARK];
  if (mark !== GATE_VERSION) {
    call.destroy();
    throw new Error(
      mark === undefined
        ? `${origin} answers, but not as the CPU gate`
        : `an older CPU gate serves ${origin}; start once its runs end`,
    );
  }
  return call;
};

/** Starts a gate through its launcher, detached and without this run's output, so the gate outlives
 *  the run. The launcher's word precedes its disconnect, and a failed start fails the join. */
const startGate = async (port: number): Promise<ChildProcess> => {
  const child = spawn(process.execPath, [GATE_SCRIPT, String(port), LAUNCH], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const said = await Promise.race([
    once(child, 'message').then(([message]: unknown[]) => String(message)),
    once(child, 'disconnect').then(() => 'its launcher ended without a word'),
  ]);
  child.unref();
  if (said !== SERVES && said !== TAKEN) {
    throw new Error(`the CPU gate on port ${String(port)} could not start: ${said}`);
  }
  return child;
};

/** The gates one join may start. Each that finds the port taken leaves the join to the gate there,
 *  so a row of them that the join then finds gone means something else holds the port. */
const STARTS = 10;

/** Joins the gate on `port`, starting one when none answers. A launcher holds the gate it started
 *  until this run joins, then goes, so the gate is nobody's child and outlives the run. */
const join = async (port: number, run: string, starts = STARTS): Promise<Joined> => {
  const origin = `http://127.0.0.1:${String(port)}`;
  const joined = await tryJoin(origin, run);
  if (joined !== undefined) {
    return joined;
  }
  if (starts === 0) {
    throw new Error(
      `nothing answers as the CPU gate on ${origin}, yet each of the ${String(STARTS)} gates started there found the port taken`,
    );
  }
  const launcher = await startGate(port);
  try {
    return await join(port, run, starts - 1);
  } finally {
    if (launcher.connected) {
      launcher.disconnect();
    }
    if (launcher.exitCode === null && launcher.signalCode === null) {
      await once(launcher, 'exit');
    }
  }
};

/** A run's hold on the gate: its name, its open join, whether it has left and why, the next
 *  change of its join (a rejoin, or its end), and who hears why should it lose the gate. */
interface Held {
  readonly port: number;
  readonly run: string;
  readonly lost: ((reason: unknown) => void) | undefined;
  call: Joined;
  left: boolean;
  /** Whether the run itself let go, as only its own leave says: a gate it lost is no letting go. */
  letGo: boolean;
  reason: unknown;
  changed: PromiseWithResolvers<void>;
}

/** Tells every turn waiting on the join's next change that it has come. */
const change = (held: Held): void => {
  const { changed } = held;
  held.changed = Promise.withResolvers();
  changed.resolve();
};

/** Ends the run's hold, refusing every turn that waits on it. */
const end = (held: Held, reason: unknown): void => {
  held.left = true;
  held.reason = reason;
  change(held);
};

/** Joins the next gate under the run's name once its own has gone, and keeps that join; a run
 *  that has let go meanwhile drops it, and one that can't join is told why. */
const rejoin = (held: Held): void => {
  join(held.port, held.run).then(
    (call) => {
      held.call = call;
      if (held.left) {
        call.destroy();
      } else {
        keep(held);
        change(held);
      }
    },
    (error: unknown) => {
      end(held, error);
      if (held.lost !== undefined) {
        held.lost(error);
      }
    },
  );
};

/** Rejoins as the gate closes the run's join, unless the run closed it itself. */
const keep = (held: Held): void => {
  held.call.once('close', () => {
    if (!held.left) {
      rejoin(held);
    }
  });
};

/** A turn the gate can't give while it changes hands: none answers, or it hasn't seen the run. */
const notYet = (error: unknown): boolean => isAbsent(error) || statusOf(error) === 404;

/** A turn at the gate for one of the run's holders, waiting for the join to change while the gate
 *  can't give it. One the gate ends cuts the holder's off, or ends it whole once the run let go. */
const turnAtGate = async (
  held: Held,
  asked: {
    readonly whole: boolean;
    readonly holder: ServerResponse;
    readonly who: string;
    readonly deadline: number | undefined;
    readonly id: string | undefined;
  },
  gone: AbortSignal,
): Promise<() => void> => {
  const { promise: changed } = held.changed;
  const size = asked.whole ? `/${WHOLE}` : '';
  const url = new URL(`http://127.0.0.1:${String(held.port)}/cpu/${held.run}${size}`);
  const kind: HoldKind = {
    held: 'a CPU turn',
    refused: (status) => `the CPU gate refused a turn (${String(status)})`,
    ended: () => {
      if (held.letGo) {
        asked.holder.end();
      } else {
        asked.holder.destroy();
      }
    },
  };
  try {
    const { who, deadline, id } = asked;
    return await openHold(url, kind, { signal: gone, who, deadline, id });
  } catch (error) {
    if (held.left || !notYet(error)) {
      throw held.left ? new Error('the run has left the CPU gate', { cause: held.reason }) : error;
    }
    await changed;
    return turnAtGate(held, asked, gone);
  }
};

/** A turn's moved deadline, passed on to the gate the turn is held at, which a gate too old to
 *  know the route refuses: the turn keeps the deadline it was asked with. */
const passDeadline = (port: number, path: string): void => {
  const call = request(`http://127.0.0.1:${String(port)}${path}`, { method: 'POST' }, (answer) => {
    answer.resume();
  });
  call.once('error', () => {
    // A gate gone: there is no turn there to move.
  });
  call.end();
};

/** Serves the run's turns to its holders, in this process or its workers, at a local URL; the
 *  server lets the process end, and stops taking turns as the run leaves. */
const serveTurns = async (held: Held): Promise<Server> => {
  const server = createServer({ requestTimeout: 0 }, (incoming, holder) => {
    incoming.resume();
    const path = incoming.url ?? '';
    if (path === '/holders') {
      answerHolders(holder);
      return;
    }
    if (path.startsWith('/deadline/')) {
      const parts = path.split('/');
      answerDeadline(holder, parts[2] ?? '', parts[3] ?? '');
      passDeadline(held.port, path);
      return;
    }
    const asked = {
      whole: path === `/cpu/${WHOLE}`,
      holder,
      who: holderOf(incoming),
      deadline: deadlineOf(incoming),
      id: holdIdOf(incoming),
    };
    const turn = { release: (): void => undefined };
    holdOpen(holder, {
      take: async (gone) => {
        turn.release = await turnAtGate(held, asked, gone);
      },
      give: () => {
        turn.release();
      },
      what: asked.whole ? 'every CPU slot' : 'a CPU turn',
      who: asked.who,
      deadline: asked.deadline,
      id: asked.id,
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  return server;
};

const portOf = (server: Server): number => {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
};

/** Joins the gate on `port` as a new run, which joins the next under its name should the gate go,
 *  so its tests' turns go on there; `lost` hears why if it can't. */
export const joinGate = async (
  port = GATE_PORT,
  lost?: (reason: unknown) => void,
): Promise<Membership> => {
  const run = randomUUID();
  const held: Held = {
    port,
    run,
    lost,
    call: await join(port, run),
    left: false,
    letGo: false,
    reason: undefined,
    changed: Promise.withResolvers(),
  };
  keep(held);
  const server = await serveTurns(held);
  return {
    turns: `http://127.0.0.1:${String(portOf(server))}/cpu`,
    leave: () => {
      held.letGo = true;
      end(held, 'it let go');
      held.call.destroy();
      server.close();
    },
  };
};
