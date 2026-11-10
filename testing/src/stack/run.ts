import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';

/** When process `pid` began, as `ps` tells it, or nothing once it's gone. */
const beganOf = (pid: string): string => {
  const asked = spawnSync('ps', ['-o', 'lstart=', '-p', pid], { encoding: 'utf8' });
  return asked.status === 0 ? asked.stdout.trim() : '';
};

const HOST = hostname();

/** This run: the host, the process there, and when that began, which a process that reuses its
 *  id can't share. What the run leaves behind carries it. */
export const RUN = `${HOST} ${String(process.pid)} ${beganOf(String(process.pid))}`;

/** Whether a run, named as `RUN` names this one, was this host's and is gone. */
export const isGone = (
  run: string,
  began: (pid: string) => string = beganOf,
  host: string = HOST,
): boolean => {
  const [owner = '', pid = '', ...start] = run.split(' ');
  return owner === host && pid !== '' && began(pid) !== start.join(' ');
};
