// The edge's certificate: by default signed by a CA of the run's own; on request by the local CA,
// made once and kept, whose name constraints hold it to loopback for OpenSSL and macOS alike.
import assert from 'node:assert/strict';
import { randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { connect, createServer } from 'node:tls';

import { startEdge } from '../src/stack/edge.ts';
import { run } from '../src/stack/process.ts';
import { browserTrust, makeEdgeCertificate, makeLocalCertificates } from '../src/stack/tls.ts';

const { signal } = new AbortController();
const DAY_MS = 86_400_000;
const ELSEWHERE = 'example.com';
/** A public origin's host under localhost, as a run that macOS must take as a domain answers as. */
const PUBLIC_HOST = 'site.localhost';
/** What the edge's CAs say of a name outside loopback and localhost's subtree, before its names. */
const REFUSAL =
  "the edge's CAs issue for 127.0.0.1, localhost and names under localhost alone, not ";
const TRUST_SWIFT = path.join(import.meta.dirname, 'fixtures', 'trust.swift');

/** Runs `work` with a temp folder of its own, removed after. */
const inFolder = async (work: (folder: string) => Promise<void>): Promise<void> => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kit-tls-test-'));
  try {
    await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

const daysValid = (pem: string): number => {
  const { validFromDate, validToDate } = new X509Certificate(pem);
  return (validToDate.getTime() - validFromDate.getTime()) / DAY_MS;
};

/** The permissions of `file`, in octal. */
const modeOf = async (file: string): Promise<string> => {
  const { mode } = await stat(file);
  return mode.toString(8).slice(-3);
};

interface Leaf {
  readonly key: string;
  readonly cert: string;
}

/** A server leaf's extensions, for ELSEWHERE. */
const ELSEWHERE_EXTENSIONS = [
  'basicConstraints = critical, CA:FALSE',
  'keyUsage = critical, digitalSignature, keyEncipherment',
  'extendedKeyUsage = serverAuth',
  `subjectAltName = DNS:${ELSEWHERE}`,
].join('\n');

/** The arguments by which openssl signs `leaf.csr` with the CA in `ca`, into `leaf.pem`. */
const signingArgs = (ca: string): string[] => [
  'x509',
  '-req',
  '-in',
  'leaf.csr',
  '-CA',
  path.join(ca, 'ca.pem'),
  '-CAkey',
  path.join(ca, 'ca.key'),
  '-set_serial',
  `0x${randomBytes(16).toString('hex')}`,
  '-days',
  '1',
  '-sha256',
  '-extfile',
  'leaf.ext',
  '-out',
  'leaf.pem',
];

/** A leaf for ELSEWHERE in `work`'s `leaf.pem`, signed by the CA in `ca` as its own code never
 *  would. */
const signElsewhere = async (ca: string, work: string): Promise<Leaf> => {
  const openssl = async (args: readonly string[]): Promise<string> =>
    run('openssl', args, { cwd: work, signal });
  await writeFile(path.join(work, 'leaf.ext'), ELSEWHERE_EXTENSIONS);
  await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key']);
  await openssl([
    'req',
    '-new',
    '-key',
    'leaf.key',
    '-subj',
    `/CN=${ELSEWHERE}`,
    '-out',
    'leaf.csr',
  ]);
  await openssl(signingArgs(ca));
  const [key, cert] = await Promise.all([
    readFile(path.join(work, 'leaf.key'), 'utf8'),
    readFile(path.join(work, 'leaf.pem'), 'utf8'),
  ]);
  return { key, cert };
};

interface Signed {
  /** The local CA's certificate. */
  readonly ca: string;
  /** Its leaf for loopback, as the edge presents it, and one for ELSEWHERE. */
  readonly local: Leaf;
  readonly elsewhere: Leaf;
}

/** The local CA made in `folder`'s `edge-ca`, with both its leaves. */
const signedIn = async (folder: string): Promise<Signed> => {
  const ca = path.join(folder, 'edge-ca');
  const edge = await makeEdgeCertificate(signal, { localCa: ca });
  const elsewhere = await signElsewhere(ca, folder);
  return { ca: edge.trust.ca, local: edge, elsewhere };
};

/** How a Node client's handshake with a server presenting `leaf` ends, trusting `ca` alone and
 *  asking for `host`. */
const handshake = async (leaf: Leaf, ca: string, host: string): Promise<string> => {
  const server = createServer(leaf);
  server.on('tlsClientError', () => {
    // The client's refusal, which the client reports.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const socket = connect({ host: '127.0.0.1', port, servername: host, ca });
  try {
    await once(socket, 'secureConnect');
    return 'trusted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    socket.destroy();
    server.close();
    await once(server, 'close');
  }
};

await test("the default edge's CA is a throwaway one, the run's own", async () => {
  const [first, second] = await Promise.all([
    makeEdgeCertificate(signal),
    makeEdgeCertificate(signal),
  ]);
  assert.notEqual(first.trust.ca, second.trust.ca);
  assert.equal(daysValid(first.trust.ca), 1);
  assert.equal(await handshake(first, first.trust.ca, 'localhost'), 'trusted');
  assert.match(
    await handshake(first, second.trust.ca, 'localhost'),
    /^unable to verify the first certificate/u,
  );
});

await test('the local CA refuses a leaf for any other name, and makes nothing', async () => {
  await inFolder(async (folder) => {
    const ca = path.join(folder, 'edge-ca');
    const asked: readonly (readonly [readonly string[], string])[] = [
      [[ELSEWHERE], ELSEWHERE],
      [['localhost', '10.0.0.1'], '10.0.0.1'],
      [['::1', '127.0.0.1', 'local'], '::1, local'],
      [
        [PUBLIC_HOST, 'localhost.example', 'xlocalhost', '.localhost'],
        'localhost.example, xlocalhost, .localhost',
      ],
    ];
    await Promise.all(
      asked.map(async ([names, refused]) =>
        assert.rejects(makeLocalCertificates(ca, names, signal), {
          message: `${REFUSAL}${refused}`,
        }),
      ),
    );
    assert.deepEqual(await readdir(folder), []);
  });
});

await test('an edge for an origin outside localhost is refused under either CA, and nothing is made', async () => {
  await inFolder(async (folder) => {
    const ca = path.join(folder, 'edge-ca');
    const refusal = { message: `${REFUSAL}${ELSEWHERE}` };
    await assert.rejects(makeEdgeCertificate(signal, { host: ELSEWHERE }), refusal);
    await assert.rejects(makeEdgeCertificate(signal, { localCa: ca, host: ELSEWHERE }), refusal);
    assert.deepEqual(await readdir(folder), []);
  });
});

await test("both the edge's CAs hold what they sign to loopback and names under localhost", async () => {
  await inFolder(async (folder) => {
    const [throwaway, lasting] = [
      await makeEdgeCertificate(signal),
      await makeEdgeCertificate(signal, { localCa: path.join(folder, 'edge-ca') }),
    ];
    const read = async (name: string, ca: string): Promise<string> => {
      const file = path.join(folder, `${name}.pem`);
      await writeFile(file, ca);
      return run('openssl', ['x509', '-in', file, '-noout', '-text'], { signal });
    };
    const texts = await Promise.all([
      read('throwaway', throwaway.trust.ca),
      read('lasting', lasting.trust.ca),
    ]);
    for (const text of texts) {
      assert.match(
        text,
        /Name Constraints: critical\s+Permitted:\s+DNS:localhost\s+IP:127\.0\.0\.1\/255\.255\.255\.255/u,
      );
    }
  });
});

await test('the local CA lasts across runs, its key and folder its owner’s alone', async () => {
  await inFolder(async (folder) => {
    const ca = path.join(folder, 'edge-ca');
    const first = await makeEdgeCertificate(signal, { localCa: ca });
    const second = await makeEdgeCertificate(signal, { localCa: ca });
    assert.equal(second.trust.ca, first.trust.ca);
    assert.equal(first.trust.ca, await readFile(path.join(ca, 'ca.pem'), 'utf8'));
    assert.notEqual(second.cert, first.cert);
    assert.equal(new X509Certificate(first.trust.ca).ca, true);
    assert.equal(daysValid(first.trust.ca), 3650);
    assert.equal(daysValid(first.cert), 1);
    assert.equal(await modeOf(ca), '700');
    assert.equal(await modeOf(path.join(ca, 'ca.key')), '600');
  });
});

await test('two runs first using the local CA at once end with one', async () => {
  await inFolder(async (folder) => {
    const ca = path.join(folder, 'edge-ca');
    const [first, second] = await Promise.all([
      makeEdgeCertificate(signal, { localCa: ca }),
      makeEdgeCertificate(signal, { localCa: ca }),
    ]);
    assert.equal(second.trust.ca, first.trust.ca);
    assert.equal(first.trust.ca, await readFile(path.join(ca, 'ca.pem'), 'utf8'));
    assert.deepEqual(await readdir(folder), ['edge-ca']);
    const kept = await readdir(ca);
    assert.deepEqual(kept.toSorted(), ['ca.key', 'ca.pem']);
  });
});

await test("an edge's leaf names its public origin's host under localhost, which the CA admits", async () => {
  await inFolder(async (folder) => {
    const ca = path.join(folder, 'edge-ca');
    const [named, plain] = [
      await makeEdgeCertificate(signal, { localCa: ca, host: PUBLIC_HOST }),
      await makeEdgeCertificate(signal, { localCa: ca, host: 'localhost' }),
    ];
    const loopback = 'IP Address:127.0.0.1, DNS:localhost';
    assert.equal(new X509Certificate(named.cert).subjectAltName, `${loopback}, DNS:${PUBLIC_HOST}`);
    assert.equal(new X509Certificate(plain.cert).subjectAltName, loopback);
    assert.equal(await handshake(named, named.trust.ca, PUBLIC_HOST), 'trusted');
    assert.equal(
      await handshake(plain, plain.trust.ca, PUBLIC_HOST),
      `Hostname/IP does not match certificate's altnames: Host: ${PUBLIC_HOST}. is not in the cert's altnames: ${loopback}`,
    );
  });
});

await test("OpenSSL refuses a leaf for another name under the local CA's constraints", async () => {
  await inFolder(async (folder) => {
    const { ca, local, elsewhere } = await signedIn(folder);
    assert.equal(await handshake(local, ca, 'localhost'), 'trusted');
    assert.equal(await handshake(elsewhere, ca, ELSEWHERE), 'permitted subtree violation');
  });
});

await test(
  "macOS's trust evaluation takes the edge's names under the local CA, and refuses another",
  { skip: platform() === 'darwin' ? false : 'the Security framework is macOS only' },
  async () => {
    await inFolder(async (folder) => {
      const { local } = await signedIn(folder);
      const leaf = path.join(folder, 'local.pem');
      await writeFile(leaf, local.cert);
      const named = path.join(folder, 'named.pem');
      const { cert } = await makeEdgeCertificate(signal, {
        localCa: path.join(folder, 'edge-ca'),
        host: PUBLIC_HOST,
      });
      await writeFile(named, cert);
      const evaluated = await run(
        'xcrun',
        [
          'swift',
          TRUST_SWIFT,
          path.join(folder, 'edge-ca', 'ca.pem'),
          leaf,
          'localhost',
          leaf,
          '127.0.0.1',
          named,
          PUBLIC_HOST,
          path.join(folder, 'leaf.pem'),
          ELSEWHERE,
        ],
        { signal },
      );
      assert.deepEqual(evaluated.trimEnd().split('\n'), [
        'localhost: trusted',
        '127.0.0.1: trusted',
        `${PUBLIC_HOST}: trusted`,
        `${ELSEWHERE}: NameConstraints`,
      ]);
    });
  },
);

await test('an edge on the local CA presents a leaf it signed', async () => {
  await inFolder(async (folder) => {
    const ca = path.join(folder, 'edge-ca');
    // Only a handshake is asked of it: the site it would route to is never reached.
    const edge = await startEdge(
      { site: 9, api: undefined, cacheControl: undefined, siteHost: undefined },
      signal,
      { localCa: ca },
    );
    try {
      assert.equal(edge.trust.ca, await readFile(path.join(ca, 'ca.pem'), 'utf8'));
      const { port } = new URL(edge.origin);
      const socket = connect({ host: 'localhost', port: Number(port), ca: edge.trust.ca });
      await once(socket, 'secureConnect');
      socket.destroy();
    } finally {
      await edge.stop();
    }
  });
});

await test('each engine checks the edge itself where it can take the CA, and only there ignores errors', () => {
  const trust = { ca: '', spki: 'key' };
  const ignoring = (browserName: string, contained: boolean): boolean =>
    browserTrust(trust, browserName, contained).ignoreHTTPSErrors;
  assert.deepEqual(
    ['chromium', 'firefox', 'webkit'].map((name) => [ignoring(name, false), ignoring(name, true)]),
    [
      [false, true],
      [true, true],
      [true, false],
    ],
  );
  assert.deepEqual(browserTrust(trust, 'chromium').args, [
    '--ignore-certificate-errors-spki-list=key',
  ]);
});
