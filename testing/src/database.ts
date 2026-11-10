import { exec } from './stack/containers.ts';
import type { Coordinates } from './stack/stack.ts';

const FIELD = '\u001F';
const RECORD = '\u001E';

/** A statement's own calls always finish: psql answers or fails, and the test bounds the wait. */
const UNBOUNDED = new AbortController().signal;

/** Runs one statement as the database owner with psql in the stack's Postgres container and
 *  answers the rows as text fields, so a check reads storage directly. */
export const sql = async (stack: Coordinates, statement: string): Promise<string[][]> => {
  const { databaseUrl, databaseContainer } = stack;
  if (databaseUrl === undefined || databaseContainer === undefined) {
    throw new Error('this target runs no database');
  }
  const { username, pathname } = new URL(databaseUrl);
  const output = await exec(
    databaseContainer,
    [
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-A',
      '-t',
      '-F',
      FIELD,
      '-R',
      RECORD,
      '-U',
      decodeURIComponent(username),
      '-d',
      decodeURIComponent(pathname.slice(1)),
      '-c',
      statement,
    ],
    UNBOUNDED,
  );
  return output === '' ? [] : output.split(RECORD).map((row) => row.split(FIELD));
};
