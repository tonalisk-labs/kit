import { isObject, type JsonObject } from '../unknown.ts';
import { claimPort, type PortClaim } from './ports.ts';
import { run } from './process.ts';
import {
  type Address,
  type Caller,
  callerOf,
  type ContainerSpec,
  type Expiry,
  type Limits,
  LIMITS,
  type Network,
  onTheClock,
  pairsOf,
  type Runtime,
  RuntimeHungError,
  sharedMemoryOf,
} from './runtime.ts';

const VERBS = {
  create: 'create',
  copy: 'copy',
  start: 'start',
  logs: 'logs',
  address: 'inspect',
  network: 'inspect',
  exec: 'exec',
  stop: 'stop',
  remove: 'delete',
  list: 'list',
} as const;

const HUNG =
  "Apple's container services are hung, and need `container system stop` and `container system start` before stacks run again";

/** As long as Docker's, the grace a signalled child gets too (process.ts). */
const STOP_SECONDS = '10';

/** A `--mount` value is comma-separated, so a path that holds a comma would be read as two fields. */
const mountOf = ([host, inner]: readonly [string, string]): string[] => {
  if (host.includes(',') || inner.includes(',')) {
    throw new TypeError(`container mounts no path that holds a comma: ${host} at ${inner}`);
  }
  return ['--mount', `type=bind,source=${host},target=${inner},readonly`];
};

const LOOPBACK = '127.0.0.1';

/** Each port on the IPv4 loopback, where the stack's names and Mailpit's certificate are, on a
 *  port claimed among the kit's processes, since `container` picks no host port itself. */
const publishOf = (claims: readonly (readonly [number, PortClaim])[]): string[] =>
  claims.flatMap(([inner, claim]) => [
    '--publish',
    `${LOOPBACK}:${String(claim.port)}:${String(inner)}`,
  ]);

/** Each container is a virtual machine of its own, sized by its spec. A copy needs it running, so
 *  files are mounted read-only. */
const optionsOf = (spec: ContainerSpec): string[] => {
  const { machine } = spec;
  return [
    ...pairsOf('--env', spec.env),
    ...(spec.init === true ? ['--init'] : []),
    ...(machine === undefined
      ? []
      : ['--memory', `${String(machine.memory)}M`, '--cpus', String(machine.cpus)]),
    ...sharedMemoryOf(spec),
    ...(spec.files === undefined ? [] : mountOf(spec.files)),
  ];
};

const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

/** The containers a `list` or an `inspect` answers in JSON. */
const snapshotsIn = (verb: string, answer: string): JsonObject[] => {
  const parsed: unknown = JSON.parse(answer);
  if (!Array.isArray(parsed)) {
    throw new TypeError(`container ${verb} answered no list: ${answer}`);
  }
  return parsed.filter((item) => isObject(item));
};

/** The loopback ports a container's own were published on, as its configuration records them. */
const publishedIn = (id: string, answer: string): Map<number, Address> => {
  const ports = field(field(snapshotsIn('inspect', answer)[0], 'configuration'), 'publishedPorts');
  if (!Array.isArray(ports)) {
    throw new TypeError(`container inspect ${id} answered no published ports: ${answer}`);
  }
  return new Map(
    ports.flatMap((published): [number, Address][] => {
      const [inner, port] = [field(published, 'containerPort'), field(published, 'hostPort')];
      return typeof inner === 'number' && typeof port === 'number'
        ? [[inner, { host: LOOPBACK, port }]]
        : [];
    }),
  );
};

/** An address as an inspect records it, without its prefix length. */
const bare = (address: string): string => address.replace(/\/\d+$/u, '');

/** A container's address and its network's gateway, the host's address there, as an inspect
 *  records them: the address with its prefix length, which goes. */
const networkIn = (id: string, answer: string): Network => {
  const networks = field(field(snapshotsIn('inspect', answer)[0], 'status'), 'networks');
  const attached: unknown = Array.isArray(networks) ? networks.at(0) : undefined;
  const [own, host] = [field(attached, 'ipv4Address'), field(attached, 'ipv4Gateway')];
  const settled = field(attached, 'ipv6Address');
  if (typeof own !== 'string' || typeof host !== 'string') {
    throw new TypeError(`container inspect ${id} answered no network: ${answer}`);
  }
  return { own: bare(own), host, settled: typeof settled === 'string' ? bare(settled) : undefined };
};

/** The ids a `list` answers. */
const idsIn = (answer: string): Set<unknown> =>
  new Set(
    snapshotsIn('list', answer).map((snapshot) => field(field(snapshot, 'configuration'), 'id')),
  );

/** A delete of an id already gone fails, as when two runs sweep the same container, so a failed
 *  delete is done once none of its ids is listed. */
const removeOf =
  (call: Call, remove: Runtime['remove']): Runtime['remove'] =>
  async (ids) => {
    try {
      await remove(ids);
    } catch (error) {
      const listed = idsIn(await call('list', ['--all', '--format', 'json']));
      if (ids.some((id) => listed.has(id))) {
        throw error;
      }
    }
  };

const labelledIn = (answer: string, key: string): Map<string, string> =>
  new Map(
    snapshotsIn('list', answer).flatMap((snapshot): [string, string][] => {
      const configuration = field(snapshot, 'configuration');
      const id = field(configuration, 'id');
      const value = field(field(configuration, 'labels'), key);
      return typeof id === 'string' && typeof value === 'string' ? [[id, value]] : [];
    }),
  );

type Call = Caller['call'];

/** Each container's claimed host ports, released once it's stopped or removed. */
const heldPorts = (): {
  readonly hold: (id: string, claims: readonly PortClaim[]) => void;
  readonly release: (ids: readonly string[]) => void;
} => {
  const held = new Map<string, readonly PortClaim[]>();
  return {
    hold: (id, claims) => {
      held.set(id, claims);
    },
    release: (ids) => {
      for (const claim of ids.flatMap((id) => held.get(id) ?? [])) {
        claim.releaseNow();
      }
      for (const id of ids) {
        held.delete(id);
      }
    },
  };
};

type Held = ReturnType<typeof heldPorts>;

/** A create may say how its image's fetch went before the id it answers last. */
const createOf =
  (call: Call, ports: Held): Runtime['create'] =>
  async (spec, labels) => {
    const claims = await Promise.all(
      spec.ports.map(async (inner) => [inner, await claimPort()] as const),
    );
    try {
      const options = [...pairsOf('--label', labels), ...publishOf(claims), ...optionsOf(spec)];
      const answer = await call('create', [
        '--rm',
        ...options,
        spec.image,
        ...(spec.command ?? []),
      ]);
      const id = answer.slice(answer.lastIndexOf('\n') + 1);
      ports.hold(
        id,
        claims.map(([, claim]) => claim),
      );
      return id;
    } catch (error) {
      for (const [, claim] of claims) {
        claim.releaseNow();
      }
      throw error;
    }
  };

const lifecycleOf = (call: Call, ports: Held): Pick<Runtime, 'create' | 'start' | 'stop'> => ({
  create: createOf(call, ports),
  start: async (id) => {
    await call('start', [id]);
  },
  stop: async (id) => {
    await call('stop', ['--time', STOP_SECONDS, id]);
    ports.release([id]);
  },
});

const lookupsOf = (call: Call): Pick<Runtime, 'addresses' | 'labelled' | 'network'> => ({
  addresses: async (id) => publishedIn(id, await call('address', [id])),
  network: async (id) => networkIn(id, await call('network', [id])),
  labelled: async (key) => labelledIn(await call('list', ['--all', '--format', 'json']), key),
});

/** Whether `container system status` says its services run, within the bound a list has. */
const servicesRun = async (command: string, bound: AbortSignal): Promise<boolean> => {
  try {
    const status = await run(command, ['system', 'status'], { signal: bound });
    return /^status\s+running$/mu.test(status);
  } catch {
    return false;
  }
};

/** A call that fails while `container`'s services are down says how to start them. */
const explained =
  (call: Call, command: string, bound: () => AbortSignal): Call =>
  async (verb, args, signal) => {
    try {
      return await call(verb, args, signal);
    } catch (error) {
      if (error instanceof RuntimeHungError || (await servicesRun(command, bound()))) {
        throw error;
      }
      throw new Error(SERVICES_DOWN, { cause: error });
    }
  };

const SERVICES_DOWN =
  "Apple's container services aren't running: start them with `container system start`";

/** Apple's `container` as one run meets it, every call through `command`. Its containers make no
 *  anonymous volume of an image's own, so a delete leaves none. */
export const appleContainerOf = ({
  command = 'container',
  limits,
  expiry = onTheClock,
}: { command?: string; limits?: Limits; expiry?: Expiry } = {}): Runtime & Caller => {
  const caller = callerOf({
    command,
    verbs: VERBS,
    hung: HUNG,
    removeFlags: ['--force'],
    limits,
    expiry,
  });
  const { remove, removeNow } = caller;
  const call = explained(caller.call, command, () => expiry((limits ?? LIMITS).list));
  const ports = heldPorts();
  return Object.assign(caller, lifecycleOf(call, ports), lookupsOf(call), {
    call,
    remove: async (ids: readonly string[]): Promise<void> => {
      await removeOf(call, remove)(ids);
      ports.release(ids);
    },
    removeNow: (ids: readonly string[]): void => {
      removeNow(ids);
      ports.release(ids);
    },
  });
};
