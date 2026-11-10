import {
  type Address,
  type Caller,
  callerOf,
  type ContainerSpec,
  type Expiry,
  type Limits,
  pairsOf,
  type Runtime,
  sharedMemoryOf,
} from './runtime.ts';

const VERBS = {
  create: 'create',
  copy: 'cp',
  start: 'start',
  logs: 'logs',
  address: 'port',
  exec: 'exec',
  stop: 'stop',
  remove: 'rm',
  list: 'ps',
} as const;

const HUNG = "Docker's daemon is hung, and needs restarting before stacks run again";

/** Docker's containers share one kernel, its VM's or the host's, so none takes a machine of its
 *  own; each port is published on a free port of the IPv4 loopback. */
const optionsOf = (spec: ContainerSpec): string[] => [
  ...spec.ports.flatMap((port) => ['--publish', `127.0.0.1::${String(port)}`]),
  ...pairsOf('--env', spec.env),
  ...(spec.init === true ? ['--init'] : []),
  ...sharedMemoryOf(spec),
];

/** One line, as each port is published on the IPv4 loopback alone. */
const addressOf = (id: string, inner: number, answer: string): Address => {
  const port = Number(answer.slice(answer.lastIndexOf(':') + 1));
  if (!Number.isInteger(port)) {
    throw new TypeError(`docker port ${id} ${String(inner)} answered ${answer}`);
  }
  return { host: '127.0.0.1', port };
};

/** `id value` lines, the value empty where a container lacks the label; the answer is trimmed,
 *  so a last line's empty value has lost its space. */
const labelledIn = (listing: string): Map<string, string> =>
  new Map(
    listing
      .split('\n')
      .filter((line) => line !== '')
      .map((line): [string, string] => {
        const space = line.indexOf(' ');
        return space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
      }),
  );

type Call = Caller['call'];

/** Files go in by `docker cp`, which reads on the host side, so no host directory is shared with
 *  Docker. */
const lifecycleOf = (call: Call): Pick<Runtime, 'create' | 'start' | 'stop'> => ({
  create: async (spec, labels) =>
    call('create', [
      '--rm',
      ...pairsOf('--label', labels),
      ...optionsOf(spec),
      spec.image,
      ...(spec.command ?? []),
    ]),
  start: async (id, spec) => {
    if (spec.files !== undefined) {
      await call('copy', [spec.files[0], `${id}:${spec.files[1]}`]);
    }
    await call('start', [id]);
  },
  stop: async (id) => {
    await call('stop', [id]);
  },
});

const lookupsOf = (call: Call): Pick<Runtime, 'addresses' | 'labelled'> => ({
  addresses: async (id, ports) =>
    new Map(
      await Promise.all(
        ports.map(async (inner): Promise<[number, Address]> => {
          const answer = await call('address', [id, `${String(inner)}/tcp`]);
          return [inner, addressOf(id, inner, answer)];
        }),
      ),
    ),
  labelled: async (key) =>
    labelledIn(
      await call('list', [
        '--all',
        '--filter',
        `label=${key}`,
        '--format',
        `{{.ID}} {{.Label "${key}"}}`,
      ]),
    ),
});

/** Docker as one run meets it, every call through `command`. */
export const dockerOf = ({
  command = 'docker',
  limits,
  expiry,
}: { command?: string; limits?: Limits; expiry?: Expiry } = {}): Runtime & Caller => {
  const caller = callerOf({
    command,
    verbs: VERBS,
    hung: HUNG,
    removeFlags: ['--force', '--volumes'],
    limits,
    expiry,
  });
  return Object.assign(caller, lifecycleOf(caller.call), lookupsOf(caller.call));
};
