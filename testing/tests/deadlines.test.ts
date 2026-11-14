// A test's deadline follows its timeout to the server of every hold it has open: `test.setTimeout`,
// `test.slow`, which triples the timeout without `setTimeout`, and a timeout of 0, which leaves no
// deadline at all.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deadlineFrom, HOST_ENV } from '../src/stack/control.ts';
import { DEADLINE_HEADER } from '../src/stack/hold.ts';

const require = createRequire(import.meta.url);
const PLAYWRIGHT = fileURLToPath(import.meta.resolve('@playwright/test'));
const CLI = require.resolve('@playwright/test/cli');
const FIXTURES = fileURLToPath(import.meta.resolve('../src/fixtures.ts'));

const CONFIG = `import { defineConfig } from ${JSON.stringify(PLAYWRIGHT)};
export default defineConfig({ testDir: '.', reporter: 'line', timeout: 30_000, use: { site: 'stack' } });
`;

const SPEC = `import { apiTest as test } from ${JSON.stringify(FIXTURES)};
test('a test that moves its timeout three ways', async () => {
  test.setTimeout(60_000);
  test.slow();
  test.setTimeout(0);
  // Its work goes on while the moves reach the stack host.
  await new Promise((resolve) => { setTimeout(resolve, 1000); });
});
`;

/** A stack host that grants every hold and keeps what each hold and each deadline move said. */
const startHost = async (): Promise<{
  readonly origin: string;
  readonly said: string[];
  readonly close: () => void;
}> => {
  const said: string[] = [];
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    const [, action = '', , given = ''] = (incoming.url ?? '').split('/');
    if (action === 'deadline') {
      said.push(`moved ${given}`);
      outgoing.writeHead(204).end();
      return;
    }
    said.push(`asked ${String(incoming.headers[DEADLINE_HEADER])}`);
    outgoing.writeHead(200).flushHeaders();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    said,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

/** Runs the repo's suite against the host at `origin`, its coverage in a folder of its own: in the
 *  run's, which Node hands every child, a worker exiting before it writes lost kit's files. */
const ran = async (repo: string, origin: string): Promise<{ code: number; report: string }> =>
  new Promise((resolve) => {
    const env = Object.assign(structuredClone(process.env), {
      [HOST_ENV]: origin,
      NODE_V8_COVERAGE: path.join(repo, 'coverage'),
    });
    execFile(process.execPath, [CLI, 'test'], { cwd: repo, env }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), report: `${stdout}${stderr}` });
    });
  });

await test('a timeout set, made slow, or set to none moves the deadline of every hold the test has open', async () => {
  await using repo = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-deadlines-'));
  await writeFile(path.join(repo.path, 'package.json'), '{ "type": "module" }\n');
  await writeFile(path.join(repo.path, 'playwright.config.ts'), CONFIG);
  await writeFile(path.join(repo.path, 'moves.spec.ts'), SPEC);
  const host = await startHost();
  const started = Date.now();
  try {
    const { code, report } = await ran(repo.path, host.origin);
    assert.equal(code, 0, report);
  } finally {
    host.close();
  }
  // Asked with the default 30 s; told again once granted, its wait not being the test's; then
  // each move the test makes, in order.
  const [asked, granted, longer, slower, none] = host.said;
  const after = (said = ''): number => Number(said.split(' ')[1]) - started;
  assert.match(asked ?? '', /^asked \d+$/u);
  assert.ok(after(asked) >= 30_000 && after(granted) >= after(asked), host.said.join('\n'));
  assert.ok(after(longer) >= 60_000 && after(longer) < 120_000, String(longer));
  assert.ok(after(slower) >= 180_000, String(slower));
  assert.equal(none, 'moved none');
  assert.equal(host.said.length, 5, host.said.join('\n'));
});

await test('a timeout set mid-test counts from the test’s start and the hold waits it isn’t charged, not from now', () => {
  // The test began at 1 s on this clock, and its seat took 4 s, a fixture's own time.
  const clock = { start: 1000, waited: 4000 };
  assert.equal(deadlineFrom(30_000, clock), 35_000);
  // At 9 s it sets a 10 s timeout: due at 15 s, as Playwright counts, not at 19 s.
  assert.equal(deadlineFrom(10_000, clock), 15_000);
  assert.equal(deadlineFrom(0, clock), undefined);
});
