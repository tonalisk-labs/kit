import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import {
  ClientRequest,
  createServer,
  type IncomingMessage,
  request,
  type ServerResponse,
} from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import {
  CPU_GATE_ENV,
  holdTestTurn,
  holdTurn,
  type TestTimeout,
  widenTestTurn,
} from '../src/stack/control.ts';
import { isAbsent, joinGate } from '../src/stack/gate-member.ts';
import {
  GATE_MARK,
  GATE_SCRIPT,
  GATE_VERSION,
  LAUNCH,
  type Semaphore,
  semaphore,
  serveGate,
  WHOLE,
} from '../src/stack/gate-server.ts';
import { freePort } from '../src/stack/ports.ts';

/** A gate of `slots` in this process, on a port of its own. */
const gateOf = async (slots: number): Promise<number> => {
  const port = await freePort();
  assert.notEqual(await serveGate(port, slots), undefined);
  return port;
};

const SERVED = 'http.server.request.start';

/** Once a server in this process has the next request made to it, as Node announces it. */
const nextServed = async (): Promise<unknown> => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const heard = (message: unknown): void => {
    unsubscribe(SERVED, heard);
    resolve(message);
  };
  subscribe(SERVED, heard);
  return promise;
};

/** Once `call` has closed, whether its abort sent an error first or not. */
const closeOf = async (call: ClientRequest): Promise<ClientRequest> => {
  const { promise, resolve } = Promise.withResolvers<ClientRequest>();
  call.once('close', () => {
    resolve(call);
  });
  return promise;
};

/** Takes `slots` of `turns` for `name`, logging the grant. */
const taker =
  (turns: Semaphore, log: string[]) =>
  async (name: string, slots = 1): Promise<void> => {
    await turns.take('run', slots, new AbortController().signal);
    log.push(name);
  };

await test('turns are granted first come, first served, as slots come free', async () => {
  const turns = semaphore(2);
  const log: string[] = [];
  const take = taker(turns, log);
  await Promise.all([take('first'), take('second')]);
  const later = Promise.all([take('third'), take('fourth')]);
  turns.give(1);
  turns.give(1);
  await later;
  assert.deepEqual(log, ['first', 'second', 'third', 'fourth']);
});

await test('a whole-machine turn waits for every slot and holds back the turns after it', async () => {
  const turns = semaphore(2);
  const log: string[] = [];
  const take = taker(turns, log);
  await take('first');
  const whole = take('whole', 2);
  const after = take('after');
  turns.give(1);
  await whole;
  turns.give(2);
  await after;
  assert.deepEqual(log, ['first', 'whole', 'after']);
});

await test('a turn given up while it waits leaves the queue', async () => {
  const port = await gateOf(1);
  const run = await joinGate(port);
  const held = await holdTurn(run.turns);
  const abandoned = request(run.turns, { method: 'POST' });
  const hungUp = Promise.withResolvers<Error>();
  abandoned.once('error', hungUp.resolve);
  abandoned.end();
  const next = holdTurn(run.turns);
  abandoned.destroy();
  const error = await hungUp.promise;
  assert.match(error.message, /socket hang up/u);
  held();
  const release = await next;
  release();
  run.leave();
});

await test("a run's waiting turns are refused as it leaves, and it serves no later one", async () => {
  const port = await gateOf(1);
  const [holder, leaving] = await Promise.all([joinGate(port), joinGate(port)]);
  const held = await holdTurn(holder.turns);
  try {
    const served = nextServed();
    const waiting = holdTurn(leaving.turns);
    await served;
    leaving.leave();
    await assert.rejects(waiting, /refused a turn/u);
    await assert.rejects(holdTurn(leaving.turns), /refused a turn \(503\): the run has left it/u);
  } finally {
    held();
    holder.leave();
  }
});

await test('runs joining and leaving at once all find one gate, started as needed', async () => {
  const port = await freePort();
  const cycle = async (): Promise<void> => {
    const run = await joinGate(port);
    const release = await holdTurn(run.turns);
    release();
    run.leave();
  };
  const runner = async (cycles: number): Promise<void> => {
    if (cycles > 0) {
      await cycle();
      await runner(cycles - 1);
    }
  };
  await Promise.all(Array.from({ length: 8 }, async () => runner(5)));
});

/** A test's timeout as a widening test sees it, with every timeout it is moved to. */
const timeoutOf = (timeout: number): TestTimeout & { readonly moved: number[] } => {
  const moved: number[] = [];
  return {
    timeout,
    moved,
    setTimeout: (ms) => {
      moved.push(ms);
    },
  };
};

/** Runs `work` as a test of a run in a gate of two slots, as the global setup leaves one. */
const inRun = async (work: (turns: string) => Promise<void>): Promise<void> => {
  const run = await joinGate(await gateOf(2));
  process.env[CPU_GATE_ENV] = run.turns;
  try {
    await work(run.turns);
  } finally {
    Reflect.deleteProperty(process.env, CPU_GATE_ENV);
    run.leave();
  }
};

await test('a widened test waits for every slot, its timeout stopped, then moved on by the wait', async () =>
  inRun(async (turns) => {
    const other = await holdTurn(turns);
    const release = await holdTestTurn();
    const timed = timeoutOf(180_000);
    const widened = widenTestTurn(timed);
    // However long the wait, none of the test's own time runs out in it.
    assert.deepEqual(timed.moved, [0], 'no timeout while it waits');
    other();
    await widened;
    const [stopped, moved = 0] = timed.moved;
    assert.equal(stopped, 0);
    assert.equal(timed.moved.length, 2);
    assert.ok(moved > 180_000, String(moved));
    // Widened, it stays: no second wait, and no second move.
    await widenTestTurn(timed);
    assert.equal(timed.moved.length, 2);
    release();
  }));

await test('a test with no timeout widens with none', async () =>
  inRun(async () => {
    const release = await holdTestTurn();
    const untimed = timeoutOf(0);
    await widenTestTurn(untimed);
    assert.deepEqual(untimed.moved, []);
    release();
  }));

const CREATED = 'http.client.request.created';

/** The request a `http.client.request.created` message announces. */
const madeIn = (message: unknown): ClientRequest | undefined => {
  const made = typeof message === 'object' && message !== null && 'request' in message;
  return made && message.request instanceof ClientRequest ? message.request : undefined;
};

/** The next request this process makes, as Node announces it, so a test can await its close. */
const nextRequest = async (): Promise<ClientRequest> => {
  const { promise, resolve } = Promise.withResolvers<ClientRequest>();
  const heard = (message: unknown): void => {
    const made = madeIn(message);
    if (made !== undefined) {
      unsubscribe(CREATED, heard);
      resolve(made);
    }
  };
  subscribe(CREATED, heard);
  return promise;
};

/** The paths of the requests this process makes while `work` runs. */
const pathsIn = async (work: () => Promise<unknown>): Promise<string[]> => {
  const paths: string[] = [];
  const heard = (message: unknown): void => {
    const made = madeIn(message);
    paths.push(made === undefined ? '' : made.path);
  };
  subscribe(CREATED, heard);
  try {
    await work();
  } finally {
    unsubscribe(CREATED, heard);
  }
  return paths;
};

await test('a test that asks to widen twice at once widens once', async () =>
  inRun(async () => {
    const release = await holdTestTurn();
    const untimed = timeoutOf(0);
    const paths = await pathsIn(async () =>
      Promise.all([widenTestTurn(untimed), widenTestTurn(untimed)]),
    );
    assert.equal(paths.filter((asked) => asked === `/cpu/${WHOLE}`).length, 1);
    release();
  }));

await test("a test's end gives up its widening still waiting, so no every-slot turn outlives it", async () =>
  inRun(async (turns) => {
    const other = await holdTurn(turns);
    const release = await holdTestTurn();
    const made = nextRequest();
    const widened = widenTestTurn(timeoutOf(0));
    const closed = closeOf(await made);
    release();
    await assert.rejects(widened, { name: 'AbortError' });
    await closed;
    other();
  }));

/** A server on a port of its own, answering each request as `answer` does. */
const serverOf = async (
  answer: (incoming: IncomingMessage, outgoing: ServerResponse) => void,
): Promise<{ readonly port: number; readonly close: () => void }> => {
  const port = await freePort();
  const server = createServer(answer);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

await test('a hold its server ends before the release fails that release, saying why', async () => {
  const granted = Promise.withResolvers<ServerResponse>();
  const server = await serverOf((incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200).flushHeaders();
    granted.resolve(outgoing);
  });
  try {
    const made = nextRequest();
    const release = await holdTurn(`http://127.0.0.1:${String(server.port)}/cpu/run`);
    const closed = once(await made, 'close');
    const hold = await granted.promise;
    hold.destroy();
    await closed;
    assert.throws(release, /a CPU turn ended before its release, so the work it covered ran/u);
  } finally {
    server.close();
  }
});

await test('a join that finds the port taken, yet nothing answering there, stops after its starts', async () => {
  const port = await freePort();
  const holder = createNetServer((socket) => {
    socket.resetAndDestroy();
  });
  holder.listen(port, '127.0.0.1');
  await once(holder, 'listening');
  try {
    await assert.rejects(
      joinGate(port),
      /nothing answers as the CPU gate on .+, yet each of the 10 gates started there found the port taken/u,
    );
  } finally {
    holder.close();
  }
});

await test('a launcher says why the gate it started could not serve', async () => {
  const launcher = spawn(process.execPath, [GATE_SCRIPT, 'no port', LAUNCH], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(launcher, 'exit');
  const said = await once(launcher, 'message').then(([message]: unknown[]) => message);
  assert.equal(said, 'the gate exited with 1');
  await exited;
  assert.equal(launcher.exitCode, 0);
});

await test('a join whose launcher cannot start fails at once, saying so', async () => {
  const options = process.env['NODE_OPTIONS'];
  process.env['NODE_OPTIONS'] = '--require=./no-such-module.cjs';
  try {
    await assert.rejects(
      joinGate(await freePort()),
      /the CPU gate on port \d+ could not start: its launcher ended without a word/u,
    );
  } finally {
    process.env['NODE_OPTIONS'] = options ?? '';
  }
});

/** A connection's failure, as Node's sockets name it by its code. */
const failed = (code: string): Error => Object.assign(new Error(code), { code });

await test('a gate that closes as a join is written counts as absent, like one that never was', () => {
  assert.deepEqual(
    ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].map((code) => isAbsent(failed(code))),
    [true, true, true, false],
  );
  assert.equal(isAbsent('EPIPE'), false);
});

const MEMBER = path.resolve(import.meta.dirname, '../src/stack/gate-member.ts');

/** A run of its own: it joins the gate on the port it is given, starting the gate as none answers,
 *  says so, and stays a member until it is stopped. */
const STARTER = `
const { joinGate } = await import(${JSON.stringify(MEMBER)});
await joinGate(Number(process.argv[1]));
process.stdout.write('joined\\n');
`;

/** `root` and every process it started, as a stop that ends a task and all it started finds
 *  them: by their parents, whatever their process group. */
const treeOf = (root: number): number[] => {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/u).map(Number));
  const tree = [root];
  for (const parent of tree) {
    tree.push(...rows.filter(([, ppid]) => ppid === parent).map(([pid = 0]) => pid));
  }
  return tree;
};

/** A turn opened by hand, granted, and whether its connection has since closed. */
const heldTurn = async (turns: string): Promise<{ closed: () => boolean; release: () => void }> => {
  const call = request(turns, { method: 'POST' });
  const shut = { closed: false };
  const answer = Promise.withResolvers<IncomingMessage>();
  call.once('response', answer.resolve).once('close', () => {
    shut.closed = true;
  });
  call.end();
  const response = await answer.promise;
  assert.equal(response.statusCode, 200);
  return {
    closed: () => shut.closed,
    release: () => {
      call.destroy();
    },
  };
};

await test('a gate outlives a stop that ends the run that started it and all it started', async () => {
  const port = await freePort();
  const starter = spawn(
    process.execPath,
    ['--input-type=module', '--eval', STARTER, String(port)],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const line = Promise.withResolvers<string>();
  starter.stdout.once('data', (chunk: Buffer) => {
    line.resolve(chunk.toString());
  });
  assert.equal(await line.promise, 'joined\n');
  const other = await joinGate(port);
  const held = await heldTurn(other.turns);
  try {
    const exited = once(starter, 'exit');
    for (const pid of treeOf(starter.pid ?? 0)) {
      process.kill(pid, 'SIGKILL');
    }
    await exited;
    // A turn after the stop: had the gate gone with its starter, the held turn's connection would
    // have closed with it, and this turn come from the gate the other run started next.
    const release = await holdTurn(other.turns);
    release();
    assert.equal(held.closed(), false);
  } finally {
    held.release();
    other.leave();
  }
});

await test('a run whose gate is stopped joins the next, and its waiting turn is granted there', async () => {
  const port = await freePort();
  const first = spawn(process.execPath, [GATE_SCRIPT, String(port)], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  await once(first, 'message');
  const run = await joinGate(port);
  first.disconnect();
  try {
    const made = nextRequest();
    const whole = await holdTurn(`${run.turns}/${WHOLE}`);
    const wholeClosed = once(await made, 'close');
    const waiting = holdTurn(run.turns);
    const stopped = once(first, 'exit');
    first.kill('SIGKILL');
    await stopped;
    const release = await waiting;
    release();
    await wholeClosed;
    assert.throws(whole, /a CPU turn ended before its release/u);
  } finally {
    run.leave();
  }
});

await test('a run that cannot join another gate once its own goes hears why at once', async () => {
  const port = await freePort();
  const joins: ServerResponse[] = [];
  const older = createServer((incoming, outgoing) => {
    incoming.resume();
    joins.push(outgoing);
    const mark = joins.length === 1 ? GATE_VERSION : '3';
    outgoing.writeHead(200, { [GATE_MARK]: mark }).flushHeaders();
  });
  older.listen(port, '127.0.0.1');
  await once(older, 'listening');
  const lost = Promise.withResolvers<unknown>();
  const run = await joinGate(port, lost.resolve);
  try {
    const [joined] = joins;
    assert.ok(joined !== undefined);
    joined.destroy();
    const reason = await lost.promise;
    assert.ok(reason instanceof Error);
    assert.match(reason.message, /an older CPU gate serves/u);
  } finally {
    run.leave();
    older.closeAllConnections();
    older.close();
  }
});
