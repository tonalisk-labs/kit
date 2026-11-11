import { leftovers } from './leftovers.ts';
import type { Service } from './process.ts';
import { isGone, RUN } from './run.ts';
import { appleContainerOf } from './runtime-apple.ts';
import { dockerOf } from './runtime-docker.ts';
import type { Address, ContainerSpec, Network, Runtime } from './runtime.ts';

export interface Container extends Service {
  readonly id: string;
  readonly address: (inner: number) => Address;
}

/** The variable naming a run's container runtime, `container` or `docker`. */
const RUNTIME_ENV = 'KIT_CONTAINER_RUNTIME';

/** Apple's `container` on macOS, which gives each container a virtual machine of its own, so no
 *  stack's containers squeeze another's memory; Docker elsewhere, Linux CI among them. */
export const runtimeOf = (
  name: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Runtime => {
  const chosen = name ?? (platform === 'darwin' ? 'container' : 'docker');
  if (chosen === 'container') {
    return appleContainerOf();
  }
  if (chosen === 'docker') {
    return dockerOf();
  }
  throw new Error(`${RUNTIME_ENV} is ${chosen}: it names container or docker`);
};

export const RUNTIME = runtimeOf(process.env[RUNTIME_ENV]);

/** The label each container carries, naming the run that made it: the host, the process there,
 *  and when that began, which a process that reuses its id can't share. */
export const RUN_LABEL = 'eu.tonalisk.kit.stack-run';

/** The containers, by their run labels, whose run on this host is gone. */
export const leftBehind = (
  labelled: ReadonlyMap<string, string>,
  began?: (pid: string) => string,
  host?: string,
): string[] => [...labelled].flatMap(([id, label]) => (isGone(label, began, host) ? [id] : []));

/** Removes the containers this host's runs left behind once their run was gone: an exit handler
 *  removes a run's own, but a SIGKILL lets none run. Another run's, still going, stays. */
export const sweepLeftBehind = async (runtime: Runtime = RUNTIME): Promise<void> => {
  const gone = leftBehind(await runtime.labelled(RUN_LABEL));
  if (gone.length > 0) {
    await runtime.remove(gone);
  }
};

/** A run sweeps once, before it makes its first container. */
const swept: { done?: Promise<void> } = {};

const sweptOnce = async (): Promise<void> => {
  swept.done ??= sweepLeftBehind();
  await swept.done;
};

/** A created container, started, or removed again if its start fails. */
const created = async (spec: ContainerSpec): Promise<{ id: string; forget: () => void }> => {
  const id = await RUNTIME.create(spec, { [RUN_LABEL]: RUN });
  const forget = leftovers.container(id, RUNTIME.removeNow);
  try {
    await RUNTIME.start(id, spec);
  } catch (error) {
    await RUNTIME.remove([id]).catch(() => '');
    forget();
    throw error;
  }
  return { id, forget };
};

const addressIn =
  (id: string, addresses: ReadonlyMap<number, Address>) =>
  (inner: number): Address => {
    const found = addresses.get(inner);
    if (found === undefined) {
      throw new RangeError(`container ${id} serves no port ${String(inner)}`);
    }
    return found;
  };

/** A container started from `spec` once it says it's ready; `started` runs as it starts, before
 *  that, for a service that waits on something the host gives it. */
export const container = async (
  spec: ContainerSpec,
  signal: AbortSignal,
  started?: (id: string) => Promise<void>,
): Promise<Container> => {
  signal.throwIfAborted();
  await sweptOnce();
  const { id, forget } = await created(spec);
  const stop = async (): Promise<void> => {
    await RUNTIME.stop(id);
    forget();
  };
  try {
    if (started !== undefined) {
      await started(id);
    }
    const texts = spec.readyInAnyOrder === true ? spec.ready.map((text) => [text]) : [spec.ready];
    await Promise.all(
      texts.map(async (text) => RUNTIME.ready(id, { texts: text, logFile: spec.logFile }, signal)),
    );
    return { id, stop, address: addressIn(id, await RUNTIME.addresses(id, spec.ports)) };
  } catch (error) {
    // The error that stopped the start is the one told: a stop that fails too adds nothing.
    await stop().catch(() => error);
    throw error;
  }
};

/** A running container's address on its network, and the host's there. */
export const networkOf = async (id: string): Promise<Network> => RUNTIME.network(id);

export const exec = async (
  id: string,
  command: readonly string[],
  signal: AbortSignal,
): Promise<string> => RUNTIME.exec(id, command, signal);

/** An exec's command line, for a caller that holds its standard input. */
export const execLine = (id: string, command: readonly string[]): readonly [string, ...string[]] =>
  RUNTIME.execLine(id, command);
