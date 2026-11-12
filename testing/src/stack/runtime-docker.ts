import { isObject } from '../unknown.ts';
import {
  type Address,
  type Caller,
  callerOf,
  type ContainerSpec,
  type Expiry,
  type Limits,
  type Network,
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
  network: 'inspect',
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

/** A container's address and its network's gateway, as `docker inspect` gives its networks in
 *  JSON. On Linux the gateway is the host's own bridge; Docker Desktop's is in its virtual
 *  machine, so a host server there would be out of the container's reach. */
const networkIn = (id: string, answer: string, platform: NodeJS.Platform): Network => {
  if (platform === 'darwin') {
    throw new Error(
      "Docker on macOS runs its containers in a virtual machine whose gateway isn't this Mac, so the Linux image's browsers can't reach its servers: run with Apple's container, unset KIT_CONTAINER_RUNTIME",
    );
  }
  const parsed: unknown = JSON.parse(answer);
  const [attached] = isObject(parsed) ? Object.values(parsed) : [];
  const [own, host, settled] = isObject(attached)
    ? [attached['IPAddress'], attached['Gateway'], attached['GlobalIPv6Address']]
    : [];
  if (typeof own !== 'string' || typeof host !== 'string' || own === '' || host === '') {
    throw new TypeError(`docker inspect ${id} answered no network: ${answer}`);
  }
  return {
    own,
    host,
    settled: typeof settled === 'string' && settled !== '' ? settled : undefined,
  };
};

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

const lookupsOf = (
  call: Call,
  platform: NodeJS.Platform,
): Pick<Runtime, 'addresses' | 'labelled' | 'network'> => ({
  network: async (id) =>
    networkIn(
      id,
      await call('network', ['--format', '{{json .NetworkSettings.Networks}}', id]),
      platform,
    ),
  addresses: async (id, ports) =>
    new Map(
      await Promise.all(
        ports.map(async (inner): Promise<[number, Address]> => {
          const answer = await call('address', [id, `${String(inner)}/tcp`]);
          return [inner, addressOf(id, inner, answer)];
        }),
      ),
    ),
  // A listing cuts each id to 12 characters unless told not to, and a create answers it whole.
  labelled: async (key) =>
    labelledIn(
      await call('list', [
        '--all',
        '--no-trunc',
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
  platform = process.platform,
}: {
  command?: string;
  limits?: Limits;
  expiry?: Expiry;
  platform?: NodeJS.Platform;
} = {}): Runtime & Caller => {
  const caller = callerOf({
    command,
    verbs: VERBS,
    hung: HUNG,
    removeFlags: ['--force', '--volumes'],
    limits,
    expiry,
  });
  return Object.assign(caller, lifecycleOf(caller.call), lookupsOf(caller.call, platform));
};
