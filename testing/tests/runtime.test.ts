import assert from 'node:assert/strict';
import { appendFile, chmod, mkdtempDisposable, readFile, watch, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runtimeOf } from '../src/stack/containers.ts';
import { ephemeralFirst, SPAN } from '../src/stack/ports.ts';
import { appleContainerOf } from '../src/stack/runtime-apple.ts';
import { dockerOf } from '../src/stack/runtime-docker.ts';
import { type ContainerSpec, RuntimeHungError, type Verb } from '../src/stack/runtime.ts';

await using temporary = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-runtime-'));

const standIn = async (name: string, script: string): Promise<string> => {
  const command = path.join(temporary.path, name);
  await writeFile(command, script);
  await chmod(command, 0o755);
  return command;
};

const created = path.join(temporary.path, 'created');

/** A docker that answers a port, a listing and a whole log at once, and never answers a create, a
 *  followed log or a followed file. */
const docker = await standIn(
  'docker',
  `#!/bin/sh
case "$1" in
  port) echo "127.0.0.1:55001" ;;
  ps) printf 'abc host 7 Wed Oct 28 09:00:00 2026\\nbare \\n' ;;
  logs) if [ "$2" = --follow ]; then exec sleep 600; fi; printf 'starting\\ninit complete\\n' ;;
  create | exec) exec sleep 600 ;;
  *) exit 0 ;;
esac
`,
);

/** A docker whose output says nothing and whose exec runs its command here, as the container would. */
const dockerFiling = await standIn(
  'docker-filing',
  `#!/bin/sh
case "$1" in
  logs) exec sleep 600 ;;
  exec) shift 2; exec "$@" ;;
  *) exit 0 ;;
esac
`,
);

/** A docker that keeps the arguments a create was given, and answers its id. */
const dockerCreating = await standIn(
  'docker-creating',
  `#!/bin/sh
case "$1" in
  create) printf '%s\\n' "$@" > '${created}'; echo 'abc' ;;
  *) exit 0 ;;
esac
`,
);

/** A \`container\` whose services are down, or up with a list that fails, as \`status\` says. */
const appleFailing = async (status: string): Promise<string> =>
  standIn(
    `container-${status}`,
    `#!/bin/sh
case "$1" in
  list) echo 'Error: the list failed' >&2; exit 1 ;;
  system) echo 'status ${status}' ;;
  *) exit 0 ;;
esac
`,
  );

/** A \`container\` whose delete fails as 1.6.1's does for an id it doesn't have, and whose list
 *  answers \`listed\`. */
const appleDeleting = async (name: string, listed: string): Promise<string> =>
  standIn(
    name,
    `#!/bin/sh
case "$1" in
  delete) echo 'Error: notFound: container with ID abc-123 not found' >&2; exit 1 ;;
  list) echo '${listed}' ;;
  *) exit 0 ;;
esac
`,
  );

/** A \`container\` that answers as 1.6.1 does: a create's progress, then its id, which keeps the
 *  arguments it was given; an inspect and a list in JSON. */
const apple = await standIn(
  'container',
  `#!/bin/sh
case "$1" in
  create) printf '%s\\n' "$@" > '${created}'; echo 'Fetching postgres'; echo 'abc-123' ;;
  inspect) echo '[{"configuration":{"id":"abc-123","publishedPorts":[{"hostAddress":"127.0.0.1","hostPort":55002,"containerPort":5432,"proto":"tcp","count":1}]},"status":{"state":"running"}}]' ;;
  list) echo '[{"configuration":{"id":"ours","labels":{"run":"host 7 then"}}},{"configuration":{"id":"theirs","labels":{}}}]' ;;
  *) exit 0 ;;
esac
`,
);

/** Every call's limit a fifth of a second, as the messages name it; a test runs a limit out. */
const SHORT: Readonly<Record<Verb, number>> = {
  create: 200,
  copy: 200,
  start: 200,
  logs: 200,
  address: 200,
  exec: 200,
  stop: 200,
  remove: 200,
  list: 200,
};

/** A limit that never runs out, and one already run out. */
const never = (): AbortSignal => new AbortController().signal;
const spent = (): AbortSignal => AbortSignal.abort(new DOMException('the limit', 'TimeoutError'));

const SPEC: ContainerSpec = {
  image: 'postgres',
  ports: [5432],
  ready: [],
  env: { POSTGRES_DB: 'app' },
  files: ['/host/certs', '/certs'],
  init: true,
  sharesMemory: true,
  machine: { memory: 2048, cpus: 3 },
};

await test('an answer within its limit is the call’s output', async () => {
  const runtime = dockerOf({ command: docker, limits: SHORT, expiry: never });
  assert.equal(await runtime.call('address', ['abc', '5432/tcp']), '127.0.0.1:55001');
});

await test('a call past its limit names the hung daemon, and every later call fails at once', async () => {
  const runtime = dockerOf({ command: docker, limits: SHORT, expiry: spent });
  await assert.rejects(runtime.call('create', ['--rm', 'postgres']), (error: unknown) => {
    assert.ok(error instanceof RuntimeHungError);
    assert.equal(
      error.message,
      `${docker} create gave no answer within 0.2 s: Docker's daemon is hung, and needs restarting before stacks run again`,
    );
    return true;
  });
  await assert.rejects(runtime.call('address', ['abc', '5432/tcp']), {
    name: 'RuntimeHungError',
    message: `${docker} port not tried: ${docker} create gave no answer within 0.2 s: Docker's daemon is hung, and needs restarting before stacks run again`,
  });
});

await test('a stop the run sends is its own, and leaves the daemon taken as answering', async () => {
  const runtime = dockerOf({ command: docker, limits: SHORT, expiry: never });
  const stop = new AbortController();
  const asked = runtime.call('create', ['--rm', 'postgres'], stop.signal);
  stop.abort('SIGTERM');
  await assert.rejects(asked, (error: unknown) => !(error instanceof RuntimeHungError));
  assert.equal(await runtime.call('address', ['abc', '5432/tcp']), '127.0.0.1:55001');
});

await test('a container that never says it’s ready fails, naming what it waited for and its output', async () => {
  const runtime = dockerOf({ command: docker, limits: SHORT, expiry: spent });
  const { signal } = new AbortController();
  await assert.rejects(runtime.ready('abc', { texts: ['ready to accept'] }, signal), {
    message:
      'container abc wrote none of ["ready to accept"] within 0.2 s; its output held 2 lines, the last: init complete',
  });
  const filed = { texts: ['ready to accept'], logFile: '/tmp/service.log' };
  await assert.rejects(runtime.ready('abc', filed, signal), {
    message:
      'container abc wrote none of ["ready to accept"] to /tmp/service.log within 0.2 s; its output held 2 lines, the last: init complete',
  });
});

await test('a service that logs to its own file is ready by its lines there, kept whole', async () => {
  const runtime = dockerOf({ command: dockerFiling, limits: SHORT, expiry: never });
  const logFile = path.join(temporary.path, 'written.log');
  await writeFile(logFile, 'starting\nready to accept\n');
  await runtime.ready('abc', { texts: ['ready to accept'], logFile }, new AbortController().signal);
  assert.equal(await readFile(logFile, 'utf8'), 'starting\nready to accept\n');
});

/** Once `name` is made in `dir`: the watch starts as this is called, before anything it awaits. */
const madeIn = async (dir: string, name: string): Promise<void> => {
  for await (const { filename } of watch(dir)) {
    if (filename === name) {
      return;
    }
  }
};

await test('a log file not there yet is made by its follower, which then sees each line added', async () => {
  const runtime = dockerOf({ command: dockerFiling, limits: SHORT, expiry: never });
  const logFile = path.join(temporary.path, 'later.log');
  const made = madeIn(temporary.path, 'later.log');
  const ready = runtime.ready(
    'abc',
    { texts: ['ready to accept'], logFile },
    new AbortController().signal,
  );
  // A follower that ends without making the file fails the race, where the watch alone would wait.
  await Promise.race([made, ready]);
  await appendFile(logFile, 'ready to accept\n');
  await ready;
});

await test('Docker’s published port is its address, and its listing its run labels', async () => {
  const runtime = dockerOf({ command: docker, limits: SHORT, expiry: never });
  assert.deepEqual(
    await runtime.addresses('abc', [5432]),
    new Map([[5432, { host: '127.0.0.1', port: 55_001 }]]),
  );
  assert.deepEqual(
    await runtime.labelled('run'),
    new Map([
      ['abc', 'host 7 Wed Oct 28 09:00:00 2026'],
      ['bare', ''],
    ]),
  );
});

await test('a container is made on a loopback port, its files mounted read-only, its machine sized', async () => {
  const runtime = appleContainerOf({ command: apple, limits: SHORT, expiry: never });
  assert.equal(await runtime.create(SPEC, { run: 'host 7 then' }), 'abc-123');
  const given = await readFile(created, 'utf8');
  const args = given.trimEnd().split('\n');
  const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
  const [, host = '', port = ''] =
    /^(?<host>[\d.]+):(?<port>\d+):5432$/u.exec(after('--publish') ?? '') ?? [];
  assert.equal(host, '127.0.0.1');
  assert.ok(Number(port) >= ephemeralFirst() - SPAN && Number(port) < ephemeralFirst(), port);
  assert.equal(after('--mount'), 'type=bind,source=/host/certs,target=/certs,readonly');
  assert.equal(after('--label'), 'run=host 7 then');
  assert.equal(after('--env'), 'POSTGRES_DB=app');
  assert.deepEqual(
    [after('--memory'), after('--cpus'), after('--shm-size')],
    ['2048M', '3', '1024M'],
  );
  assert.equal(args.at(-1), 'postgres');
  assert.ok(args.includes('--rm') && args.includes('--init'));
  await runtime.remove(['abc-123']);
});

await test('Docker gives a shared memory its size, never the host’s IPC namespace', async () => {
  const runtime = dockerOf({ command: dockerCreating, limits: SHORT, expiry: never });
  assert.equal(await runtime.create(SPEC, {}), 'abc');
  const given = await readFile(created, 'utf8');
  const args = given.trimEnd().split('\n');
  assert.equal(args[args.indexOf('--shm-size') + 1], '1024M');
  assert.equal(args[args.indexOf('--publish') + 1], '127.0.0.1::5432');
  assert.ok(!args.includes('--ipc=host') && !args.includes('--memory'));
});

await test('a call that fails while container’s services are down says how to start them', async () => {
  const down = appleContainerOf({
    command: await appleFailing('stopped'),
    limits: SHORT,
    expiry: never,
  });
  await assert.rejects(down.labelled('run'), {
    message: "Apple's container services aren't running: start them with `container system start`",
  });
  const up = appleContainerOf({
    command: await appleFailing('running'),
    limits: SHORT,
    expiry: never,
  });
  await assert.rejects(up.labelled('run'), { message: /Error: the list failed/u });
});

await test('a container’s address is the loopback port its configuration records', async () => {
  const runtime = appleContainerOf({ command: apple, limits: SHORT, expiry: never });
  assert.deepEqual(
    await runtime.addresses('abc-123', [5432]),
    new Map([[5432, { host: '127.0.0.1', port: 55_002 }]]),
  );
});

await test('only the containers that carry a label are listed with it', async () => {
  const runtime = appleContainerOf({ command: apple, limits: SHORT, expiry: never });
  assert.deepEqual(await runtime.labelled('run'), new Map([['ours', 'host 7 then']]));
});

await test('a delete is done once its ids are gone, as when another run swept them first', async () => {
  const gone = await appleDeleting('container-gone', '[]');
  await appleContainerOf({ command: gone, limits: SHORT, expiry: never }).remove(['abc-123']);
  const kept = await appleDeleting(
    'container-kept',
    '[{"configuration":{"id":"abc-123","labels":{}}}]',
  );
  await assert.rejects(
    appleContainerOf({ command: kept, limits: SHORT, expiry: never }).remove(['abc-123']),
    { message: /notFound/u },
  );
});

await test('a path that holds a comma is refused before anything is made', async () => {
  const runtime = appleContainerOf({ command: apple, limits: SHORT, expiry: never });
  const spec: ContainerSpec = Object.assign(structuredClone(SPEC), { files: ['/a,b', '/certs'] });
  await assert.rejects(runtime.create(spec, {}), {
    name: 'TypeError',
    message: 'container mounts no path that holds a comma: /a,b at /certs',
  });
});

const program = (name: string | undefined, platform: NodeJS.Platform): string =>
  runtimeOf(name, platform).execLine('id', [])[0];

await test('macOS runs Apple’s container and every other platform Docker, unless one is named', () => {
  assert.equal(program(undefined, 'darwin'), 'container');
  assert.equal(program(undefined, 'linux'), 'docker');
  assert.equal(program('docker', 'darwin'), 'docker');
  assert.throws(() => runtimeOf('podman', 'linux'), {
    message: 'KIT_CONTAINER_RUNTIME is podman: it names container or docker',
  });
});
