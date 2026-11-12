// The machine's one CPU gate: a fixed number of slots that every run's tests take in turn. A run's
// membership is its open join request; the gate closes its port as its last run leaves, then exits.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';

import { DEADLINE_HEADER, described, HOLD_ID_HEADER, HOLDER_HEADER } from './hold.ts';
import { type Held, STILLNESS, type Stillness, type Watch, watchOf } from './stall.ts';

/** The fixed local port the machine's one CPU gate listens on: every run finds it there. */
export const GATE_PORT = 47_391;

/** The header the gate answers a join with, so a run never joins some other server. */
export const GATE_MARK = 'x-sites-cpu-gate';

/** The mark's value, this protocol's version: a run finding an older gate says so plainly. */
export const GATE_VERSION = '4';

/** This module, which a run starts as the gate's own process when none answers. */
export const GATE_SCRIPT = import.meta.filename;

/** The argument that starts this module as the gate's launcher (`launch`). */
export const LAUNCH = 'launch';

/** Tests running at once on the machine, all runs together: one a core. */
export const SLOTS = availableParallelism();

/** The last segment of a turn's path that asks for every slot: a measurement load would skew. */
export const WHOLE = 'whole';

/** A hold this process serves, held or waited for, by whom, since when and by when its test must
 *  end (epoch ms). */
interface Holding {
  readonly what: string;
  readonly who: string;
  deadline: number | undefined;
  since: number;
  held: boolean;
}

/** Every hold this process serves, so a wait past its bound can name who holds and who waits. */
const holdings = new Set<Holding>();

/** Each hold's way to move its deadline, by the id its request gave. */
const renewers = new Map<string, (deadline: number | undefined) => void>();

/** A hold a server serves: how it is taken and given back, what it is, who asked for it and by
 *  when their test must end, and the watch over its resource's waits, which counts its holders. */
export interface Served {
  readonly take: (gone: AbortSignal) => Promise<void>;
  readonly give: () => void;
  readonly what: string;
  readonly who: string;
  readonly deadline?: number | undefined;
  readonly watch?: Watch;
  readonly id?: string | undefined;
}

/** A deadline as given: epoch milliseconds, or none. */
const deadlineIn = (given: unknown): number | undefined => {
  const value = Number(given);
  return typeof given === 'string' && Number.isFinite(value) && value > 0 ? value : undefined;
};

/** The deadline a request gives its holder's test, or none. */
export const deadlineOf = (incoming: IncomingMessage): number | undefined =>
  deadlineIn(incoming.headers[DEADLINE_HEADER]);

/** The id a hold's request gives itself, or none. */
export const holdIdOf = (incoming: IncomingMessage): string | undefined => {
  const id = incoming.headers[HOLD_ID_HEADER];
  return typeof id === 'string' && id !== '' ? id : undefined;
};

/** A hold's id as openHold makes it, a random UUID: nothing else names a hold. */
const HOLD_ID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

/** Moves the deadline of the hold `id` names to `given`, epoch milliseconds or none at all, as
 *  its test's timeout moved: 204, or 404 for a hold this process doesn't serve. A request names
 *  only an entry of the table: an id of another shape is looked up nowhere. */
export const answerDeadline = (outgoing: ServerResponse, id: string, given: string): void => {
  const renew = HOLD_ID.test(id) && renewers.has(id) ? renewers.get(id) : undefined;
  if (typeof renew !== 'function') {
    outgoing.writeHead(404).end('no such hold here');
    return;
  }
  renew(deadlineIn(given));
  outgoing.writeHead(204).end();
};

/** The holder a request names, decoded, or as sent where it isn't URI-encoded; or that it named
 *  none. */
export const holderOf = (incoming: IncomingMessage): string => {
  const named = incoming.headers[HOLDER_HEADER];
  if (typeof named !== 'string' || named === '') {
    return 'an unnamed holder';
  }
  try {
    return decodeURIComponent(named);
  } catch {
    return named;
  }
};

/** This process's holdings, each named as GET /holders gives it: what, by whom, for how long. */
export const holdingsNamed = (): string => {
  const now = Date.now();
  return holdings.size === 0
    ? 'it records no holder or waiter'
    : [...holdings].map((holding) => described(holding, now)).join('; ');
};

/** Answers a GET /holders with this process's holdings, as JSON. */
export const answerHolders = (outgoing: ServerResponse): void => {
  outgoing
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify([...holdings]));
};

/** A hold (a stack lock, a CPU turn) lasts as long as its request stays open: granted with the
 *  response head, given back when the caller closes it, however its worker ends. */
export const holdOpen = (outgoing: ServerResponse, served: Served): void => {
  const { take, give, what, who, deadline, watch, id } = served;
  const gone = new AbortController();
  const granted: { now: boolean; held?: Held } = { now: false };
  const holding: Holding = { what, who, deadline, since: Date.now(), held: false };
  holdings.add(holding);
  if (id !== undefined) {
    renewers.set(id, (moved) => {
      holding.deadline = moved;
      if (granted.held !== undefined) {
        granted.held.renew(moved);
      }
    });
  }
  outgoing.once('close', () => {
    holdings.delete(holding);
    if (id !== undefined) {
      renewers.delete(id);
    }
    gone.abort();
    if (granted.now) {
      if (granted.held !== undefined) {
        granted.held.release();
      }
      give();
    }
  });
  take(gone.signal)
    .then(() => {
      // Granted as the caller left: nobody holds it, so it goes straight back.
      if (gone.signal.aborted) {
        give();
        return;
      }
      granted.now = true;
      if (watch !== undefined) {
        granted.held = watch.holding(holding.deadline);
      }
      holding.held = true;
      holding.since = Date.now();
      outgoing.writeHead(200).flushHeaders();
    })
    .catch((error: unknown) => {
      outgoing.writeHead(503).end(error instanceof Error ? error.message : String(error));
    });
};

interface Waiting {
  readonly run: string;
  readonly slots: number;
  readonly grant: () => void;
  readonly refuse: (reason: Error) => void;
}

export interface Semaphore {
  readonly take: (run: string, slots: number, gone: AbortSignal) => Promise<void>;
  readonly give: (slots: number) => void;
  readonly refuse: (run: string) => void;
  /** The watch over its waits, which a server counts each holder in. */
  readonly watch: Watch;
}

/** The free slots and the turns waiting for them, in the order they asked, and its watch. */
interface Queue {
  free: number;
  readonly waiting: Set<Waiting>;
  readonly watch: Watch;
}

/** Grants the waiting turns in order while the first fits, so a turn asking more than are free
 *  holds back every later one. */
const admit = (queue: Queue): void => {
  for (const next of queue.waiting) {
    if (next.slots > queue.free) {
      return;
    }
    queue.waiting.delete(next);
    queue.free -= next.slots;
    next.grant();
  }
};

const enqueue = async (
  queue: Queue,
  { run, slots }: { readonly run: string; readonly slots: number },
  gone: AbortSignal,
): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const done = queue.watch.waiting((stalled) => {
    queue.waiting.delete(waiting);
    waiting.refuse(stalled);
    admit(queue);
  });
  const waiting: Waiting = {
    run,
    slots,
    grant: () => {
      done();
      queue.watch.moved();
      resolve(true);
    },
    refuse: (reason) => {
      done();
      reject(reason);
    },
  };
  gone.addEventListener(
    'abort',
    () => {
      done();
      queue.waiting.delete(waiting);
      admit(queue);
    },
    { once: true },
  );
  queue.waiting.add(waiting);
  admit(queue);
  await promise;
};

/** The slots, first come, first served, so a whole-machine turn is never starved. A set keeps the
 *  order with O(1) removal. A wait fails once no slot has changed hands for the stillness's stall,
 *  saying `what` stood still. */
export const semaphore = (
  slots: number,
  { stillness = STILLNESS, what = 'no slot' }: { stillness?: Stillness; what?: string } = {},
): Semaphore => {
  const watch = watchOf(stillness, { what, named: holdingsNamed });
  const queue: Queue = { free: slots, waiting: new Set(), watch };
  return {
    watch,
    take: async (run, asked, gone) => enqueue(queue, { run, slots: asked }, gone),
    give: (given) => {
      watch.moved();
      queue.free += given;
      admit(queue);
    },
    refuse: (run) => {
      for (const waiting of queue.waiting) {
        if (waiting.run === run) {
          queue.waiting.delete(waiting);
          waiting.refuse(new Error('the run left the CPU gate'));
        }
      }
    },
  };
};

/** A running gate: its members, the starter's hold among them until it lets go. */
export interface Gate {
  readonly hold: (run: string) => void;
  readonly leave: (run: string) => void;
}

const listen = async (server: Server, port: number): Promise<boolean> => {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  server
    .once('listening', () => {
      resolve(true);
    })
    .once('error', (error) => {
      if ('code' in error && error.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        reject(error);
      }
    });
  server.listen(port, '127.0.0.1');
  return promise;
};

/** A gate's state: its turns, the runs in it, and the runs that have left. */
interface Runs {
  readonly turns: Semaphore;
  readonly slots: number;
  readonly members: Set<string>;
  readonly left: Set<string>;
}

/** A turn for `run`: held while it's a member, gone (410) once it has left, and not found (404)
 *  for a run never seen, whose gate was stopped and which is rejoining this one. */
const turnFor = (
  runs: Runs,
  {
    run,
    size,
    incoming,
  }: { readonly run: string; readonly size: string; readonly incoming: IncomingMessage },
  outgoing: ServerResponse,
): void => {
  if (runs.members.has(run)) {
    const asked = size === WHOLE ? runs.slots : 1;
    holdOpen(outgoing, {
      take: async (gone) => runs.turns.take(run, asked, gone),
      give: () => {
        runs.turns.give(asked);
      },
      what: `${String(asked)} of the CPU gate's slots for run ${run}`,
      who: holderOf(incoming),
      deadline: deadlineOf(incoming),
      watch: runs.turns.watch,
      id: holdIdOf(incoming),
    });
  } else if (runs.left.has(run)) {
    outgoing.writeHead(410).end(`no cpu for ${run}, which has left`);
  } else {
    outgoing.writeHead(404).end(`no cpu for ${run}, which has not joined`);
  }
};

const answer =
  (gate: Gate, runs: Runs) =>
  (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    const [, action = '', encoded = '', size = ''] = (incoming.url ?? '').split('/');
    const run = decodeURIComponent(encoded);
    incoming.resume();
    if (action === 'holders') {
      answerHolders(outgoing);
    } else if (action === 'deadline') {
      answerDeadline(outgoing, run, size);
    } else if (run === '') {
      outgoing.writeHead(404).end(`no run named for ${action}`);
    } else if (action === 'join') {
      gate.hold(run);
      outgoing.once('close', () => {
        gate.leave(run);
      });
      outgoing.writeHead(200, { [GATE_MARK]: GATE_VERSION }).flushHeaders();
    } else if (action === 'cpu') {
      turnFor(runs, { run, size, incoming }, outgoing);
    } else {
      outgoing.writeHead(404).end(`no ${action} for ${run}, which has not joined`);
    }
  };

/** The gate on a listening server: a run joins, holds turns while joined, and leaves. Its last
 *  member's leave closes the port before anything else, so a join it then refuses finds it free. */
const gateOn = (server: Server, slots: number): Gate => {
  const turns = semaphore(slots, { what: 'no CPU turn' });
  const runs: Runs = { turns, slots, members: new Set(), left: new Set() };
  const gate: Gate = {
    hold: (run) => {
      runs.left.delete(run);
      runs.members.add(run);
    },
    leave: (run) => {
      runs.members.delete(run);
      runs.left.add(run);
      runs.turns.refuse(run);
      if (runs.members.size === 0) {
        server.close();
        server.closeAllConnections();
      }
    },
  };
  server.on('request', answer(gate, runs));
  return gate;
};

export const serveGate = async (port: number, slots = SLOTS): Promise<Gate | undefined> => {
  // A membership is a request open for the whole run: no request timeout may cut it off.
  const server = createServer({ requestTimeout: 0 });
  return (await listen(server, port)) ? gateOn(server, slots) : undefined;
};

/** What a launcher tells its run: the gate serves, or exited cleanly as another holds the port.
 *  Anything else it says is why the gate failed. */
export const SERVES = 'serves';
export const TAKEN = 'taken';

/** The gate's launcher: it starts the gate as its own process, tells the run what came of it, and
 *  holds a gate that serves until the run lets go, so the gate is then nobody's child. */
const launch = async (port: string): Promise<void> => {
  const gate = spawn(process.execPath, [GATE_SCRIPT, port], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const outcome = await Promise.race([
    once(gate, 'message').then(() => SERVES),
    once(gate, 'exit').then(([code, signal]: unknown[]) =>
      code === 0 ? TAKEN : `the gate exited with ${String(code ?? signal)}`,
    ),
  ]);
  gate.unref();
  process.once('disconnect', () => {
    if (gate.connected) {
      gate.disconnect();
    }
  });
  if (process.send !== undefined) {
    process.send(outcome, () => {
      if (outcome !== SERVES && process.disconnect !== undefined) {
        process.disconnect();
      }
    });
  }
};

/** The gate's own process; its launcher holds it, as the run named '', until its run has joined. */
const main = async (): Promise<void> => {
  if (process.send === undefined || process.disconnect === undefined) {
    throw new Error('a run starts the CPU gate, and holds it over IPC until it joins');
  }
  const port = process.argv[2] ?? '';
  if (process.argv[3] === LAUNCH) {
    await launch(port);
    return;
  }
  const gate = await serveGate(Number(port));
  if (gate === undefined) {
    process.disconnect();
    return;
  }
  gate.hold('');
  process.once('disconnect', () => {
    gate.leave('');
  });
  process.send('ready');
};

if (import.meta.main) {
  await main();
}
