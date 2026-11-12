import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { discover } from '../discover.ts';
import { BROWSER_SEATS, startBrowserServer } from './browsers.ts';
import {
  type Action,
  CPU_GATE_ENV,
  HOST_ENV,
  LINUX_BROWSERS,
  LINUX_ENV,
  STACK_ENV,
} from './control.ts';
import { joinGate, type Membership } from './gate-member.ts';
import {
  answerDeadline,
  answerHolders,
  deadlineOf,
  holderOf,
  holdIdOf,
  holdOpen,
} from './gate-server.ts';
import { seatPool, stackLocks } from './lock.ts';
import type { Service } from './process.ts';
import { startTarget } from './stack.ts';

const ACTIONS: readonly Action[] = ['start', 'stop', 'restart'];

interface Started extends Service {
  readonly env: Record<string, string>;
  readonly restart?: (() => Promise<void>) | undefined;
}

interface Entry {
  readonly abort: AbortController;
  readonly started: Promise<Started>;
}

const startKey = async (key: string, turns: string, signal: AbortSignal): Promise<Started> => {
  if (key === LINUX_BROWSERS) {
    const server = await startBrowserServer(signal);
    return { env: { [LINUX_ENV]: JSON.stringify(server.endpoints) }, stop: server.stop };
  }
  const target = discover().find(({ name }) => name === key);
  if (target === undefined) {
    throw new Error(`no target is named ${key}`);
  }
  const running = await startTarget(target, { signal, turns });
  return {
    env: { [STACK_ENV]: JSON.stringify(running.coordinates) },
    stop: running.stop,
    restart: running.restartBackend,
  };
};

const stopKey = async (entries: Map<string, Entry>, key: string): Promise<void> => {
  const entry = entries.get(key);
  if (entry === undefined) {
    return;
  }
  entries.delete(key);
  entry.abort.abort(new Error(`${key} was stopped while starting`));
  const [outcome] = await Promise.allSettled([entry.started]);
  if (outcome.status === 'fulfilled') {
    await outcome.value.stop();
  }
};

/** Restarts a running target's backend, its entry read again once started, as a stop meanwhile
 *  leaves nothing to restart. */
const restartKey = async (entries: Map<string, Entry>, key: string): Promise<void> => {
  const entry = entries.get(key);
  const running = entry === undefined ? undefined : await entry.started;
  if (running === undefined || entries.get(key) !== entry) {
    throw new Error(`${key} isn't running, so there's nothing to restart`);
  }
  if (running.restart === undefined) {
    throw new Error(`${key} runs no backend to restart`);
  }
  await running.restart();
};

const locks = stackLocks();
const browsers = seatPool(BROWSER_SEATS);

const answer = async ({ entries, turns }: Hosted, action: Action, key: string): Promise<object> => {
  if (action === 'stop') {
    await stopKey(entries, key);
    return {};
  }
  if (action === 'restart') {
    await restartKey(entries, key);
    return {};
  }
  const existing = entries.get(key);
  if (existing !== undefined) {
    const started = await existing.started;
    return started.env;
  }
  const abort = new AbortController();
  const started = startKey(key, turns, abort.signal);
  entries.set(key, { abort, started });
  const { env } = await started;
  return env;
};

interface Hosted {
  readonly entries: Map<string, Entry>;
  readonly turns: string;
}

const handle =
  (hosted: Hosted) =>
  (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    const [, action = '', key = '', given = ''] = (incoming.url ?? '').split('/');
    if (action === 'holders') {
      answerHolders(outgoing);
      return;
    }
    if (action === 'deadline') {
      answerDeadline(outgoing, key, given);
      return;
    }
    if (action === 'browser') {
      browsers(outgoing, key, {
        who: holderOf(incoming),
        deadline: deadlineOf(incoming),
        id: holdIdOf(incoming),
      });
      return;
    }
    if (action === 'share' || action === 'own') {
      const stack = decodeURIComponent(key);
      holdOpen(outgoing, {
        take: async (gone) => locks.take(stack, action, gone),
        give: () => {
          locks.give(stack, action);
        },
        what: `a ${action} hold on ${stack}`,
        who: holderOf(incoming),
        deadline: deadlineOf(incoming),
        watch: locks.watch(stack),
        id: holdIdOf(incoming),
      });
      return;
    }
    const called = ACTIONS.find((known) => known === action);
    const reply =
      called === undefined
        ? Promise.reject(new Error(`unknown action ${action}`))
        : answer(hosted, called, decodeURIComponent(key));
    reply
      .then((body) => {
        outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      })
      .catch((error: unknown) => {
        outgoing
          .writeHead(500)
          .end(error instanceof Error ? (error.stack ?? error.message) : String(error));
      });
  };

/** SIGINT aborts every start and leaves the gate, which refuses the run's waiting tests; SIGTERM
 *  becomes SIGINT and exits 143. Kept all run: a re-raised signal cannot end it half torn down. */
const interruptible = (entries: Map<string, Entry>, gate: Membership): void => {
  const interrupt = (): void => {
    gate.leave();
    for (const { abort } of entries.values()) {
      abort.abort(new Error('interrupted'));
    }
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', () => {
    process.once('exit', () => {
      process.exitCode = 143;
    });
    process.emit('SIGINT', 'SIGINT');
  });
};

/** The global setup: joins the CPU gate, stopping the run at once should it lose it, and hosts
 *  every service the setup projects start; its teardown stops what is left. */
const globalSetup = async (): Promise<() => Promise<void>> => {
  const gate = await joinGate(undefined, (reason) => {
    console.error(`The run lost the CPU gate and could not join another: ${String(reason)}`);
    process.emit('SIGINT', 'SIGINT');
  });
  const hosted = { entries: new Map<string, Entry>(), turns: gate.turns };
  interruptible(hosted.entries, gate);
  process.env[CPU_GATE_ENV] = gate.turns;
  const server = createServer(handle(hosted));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.env[HOST_ENV] = `http://127.0.0.1:${String(port)}`;
  return async () => {
    gate.leave();
    const { entries } = hosted;
    await Promise.all([...entries.keys()].map(async (key) => stopKey(entries, key)));
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  };
};

export default globalSetup;
