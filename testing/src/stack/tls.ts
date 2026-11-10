import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { codeOf } from '../unknown.ts';
import { leftovers } from './leftovers.ts';
import { run, type Service } from './process.ts';

export interface Certificates extends Service {
  /** The directory holding `cert.pem` and `key.pem`, copied into the server that presents them. */
  readonly dir: string;
  /** The CA a client must trust, and nothing else. */
  readonly caFile: string;
}

/** Where the local CA is kept: outside every repo, one for the machine. */
export const LOCAL_CA_DIR = path.join(
  homedir(),
  'Library',
  'Application Support',
  'tonalisk-kit',
  'edge-ca',
);

/** The names the edge answers to whatever its public origin. */
const LOCAL_NAMES: readonly string[] = ['127.0.0.1', 'localhost'];

/** A name under localhost, which RFC 6761 keeps on loopback: macOS resolves it there, and takes it
 *  as a domain where it refuses localhost itself, which has no period. */
const UNDER_LOCALHOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/u;

/** Whether the local CA's name constraints permit `name`: loopback's own, or a name under
 *  localhost, which its DNS constraint covers. */
const permitted = (name: string): boolean =>
  LOCAL_NAMES.includes(name) || UNDER_LOCALHOST.test(name);

/** Refuses, before anything is made, any of `names` the CAs' name constraints do not permit. */
const refuseUnpermitted = (names: readonly string[]): void => {
  const refused = names.filter((name) => !permitted(name));
  if (refused.length > 0) {
    const allowed = `${LOCAL_NAMES.join(', ')} and names under localhost`;
    throw new Error(`the edge's CAs issue for ${allowed} alone, not ${refused.join(', ')}`);
  }
};

/** The names the edge's leaf carries: loopback's, and the public origin's `host` if it has one,
 *  refused unless the CA that signs it, throwaway or lasting, permits it. */
const edgeNames = (host: string | undefined): readonly string[] => {
  const names =
    host === undefined || LOCAL_NAMES.includes(host) ? LOCAL_NAMES : [...LOCAL_NAMES, host];
  refuseUnpermitted(names);
  return names;
};

/** Both CAs' name constraints, which hold whatever they sign to loopback and names under it. */
const LOOPBACK_ONLY =
  'nameConstraints = critical, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255';

const openssl = async (
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<void> => {
  await run('openssl', args, { cwd, signal });
};

const altName = (name: string): string => (isIP(name) === 0 ? `DNS:${name}` : `IP:${name}`);

/** Server extensions: rustls accepts only a v3 leaf naming its host in subjectAltName. */
const leafExtensions = (names: readonly string[]): string =>
  [
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${names.map((name) => altName(name)).join(', ')}`,
  ].join('\n');

interface Kind {
  readonly subject: string;
  readonly days: number;
  readonly extensions: readonly string[];
}

/** One run's CA, under a name of its own: TLS finds a leaf's issuer by name, so stacks trusted in
 *  one process under a shared name would have their leaves checked against another's key. */
const throwaway = (): Kind => ({
  subject: `/CN=sites-testing throwaway CA ${randomUUID()}`,
  days: 1,
  extensions: [
    'basicConstraints = critical, CA:TRUE',
    'keyUsage = critical, keyCertSign, cRLSign',
    LOOPBACK_ONLY,
  ],
});

/** The CA kept across runs, for a client that trusts only a root installed as trusted, such as
 *  macOS's swcd: it signs leaves alone, and those only for loopback. */
const local = (): Kind => ({
  subject: `/CN=tonalisk-kit local CA ${randomUUID()}`,
  // Ten years: it is installed as trusted by hand, which a short life would make a chore, and its
  // name constraints hold it to loopback however long it lives.
  days: 3650,
  extensions: [
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    LOOPBACK_ONLY,
  ],
});

/** A CA's certificate and key, by the files that hold them. */
interface Authority {
  readonly certFile: string;
  readonly keyFile: string;
}

const authorityIn = (dir: string): Authority => ({
  certFile: path.join(dir, 'ca.pem'),
  keyFile: path.join(dir, 'ca.key'),
});

const makeAuthority = async (cwd: string, kind: Kind, signal: AbortSignal): Promise<Authority> => {
  const authority = authorityIn(cwd);
  await openssl(
    ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', authority.keyFile],
    cwd,
    signal,
  );
  await openssl(
    [
      'req',
      '-x509',
      '-new',
      '-key',
      authority.keyFile,
      '-sha256',
      '-days',
      String(kind.days),
      '-out',
      authority.certFile,
      '-subj',
      kind.subject,
      ...kind.extensions.flatMap((extension) => ['-addext', extension]),
    ],
    cwd,
    signal,
  );
  return authority;
};

/** What a rename answers when its destination is a folder already filled. */
const FILLED = new Set<unknown>(['ENOTEMPTY', 'EEXIST']);

/** The local CA in `dir`, made on first use aside in its parent and renamed into place: of two
 *  runs that start at once, one makes it and the other reads the one made. */
const localAuthority = async (dir: string, signal: AbortSignal): Promise<Authority> => {
  const authority = authorityIn(dir);
  if (existsSync(authority.certFile)) {
    return authority;
  }
  const parent = path.dirname(dir);
  await mkdir(parent, { recursive: true });
  const aside = await mkdtemp(path.join(parent, `${path.basename(dir)}-`));
  const forget = leftovers.dir(aside);
  try {
    const made = await makeAuthority(aside, local(), signal);
    await chmod(made.keyFile, 0o600);
    await rename(aside, dir).catch((error: unknown) => {
      if (!FILLED.has(codeOf(error))) {
        throw error;
      }
    });
  } finally {
    await rm(aside, { recursive: true, force: true });
    forget();
  }
  return authority;
};

/** Signs the leaf's request under a random serial: the local CA outlives any run and keeps no
 *  serial file, and a client refuses a second certificate under one issuer and serial. */
const signLeaf = async (cwd: string, authority: Authority, signal: AbortSignal): Promise<void> => {
  await openssl(
    [
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      authority.certFile,
      '-CAkey',
      authority.keyFile,
      '-set_serial',
      `0x${randomBytes(16).toString('hex')}`,
      '-days',
      '1',
      '-sha256',
      '-extfile',
      'leaf.ext',
      '-out',
      path.join(cwd, 'server', 'cert.pem'),
    ],
    cwd,
    signal,
  );
};

interface Issue {
  readonly authority: Authority;
  readonly names: readonly string[];
}

const makeLeaf = async (
  cwd: string,
  { authority, names }: Issue,
  signal: AbortSignal,
): Promise<void> => {
  const certs = path.join(cwd, 'server');
  await writeFile(path.join(cwd, 'leaf.ext'), `${leafExtensions(names)}\n`);
  await openssl(
    ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key'],
    cwd,
    signal,
  );
  await openssl(
    ['pkcs8', '-topk8', '-nocrypt', '-in', 'leaf.key', '-out', path.join(certs, 'key.pem')],
    cwd,
    signal,
  );
  await openssl(
    ['req', '-new', '-key', 'leaf.key', '-subj', '/CN=localhost', '-out', 'leaf.csr'],
    cwd,
    signal,
  );
  await signLeaf(cwd, authority, signal);
};

/** Made by the system `openssl` in a temp dir that stopping removes, `make` answering the CA's
 *  file. */
const certificatesIn = async (make: (cwd: string) => Promise<string>): Promise<Certificates> => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'sites-testing-tls-'));
  const forget = leftovers.dir(cwd);
  const stop = async (): Promise<void> => {
    await rm(cwd, { recursive: true, force: true });
    forget();
  };
  try {
    await mkdir(path.join(cwd, 'server'));
    const caFile = await make(cwd);
    return { dir: path.join(cwd, 'server'), caFile, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};

/** The CA is valid one day and trusted by nothing but the stack. */
export const makeCertificates = async (
  signal: AbortSignal,
  names: readonly string[] = LOCAL_NAMES,
): Promise<Certificates> =>
  certificatesIn(async (cwd) => {
    const authority = await makeAuthority(cwd, throwaway(), signal);
    await makeLeaf(cwd, { authority, names }, signal);
    return authority.certFile;
  });

/** A leaf for `names`, signed by the local CA in `dir` (made there on first use, its key read in
 *  place); a name its constraints do not permit is refused before anything is made. */
export const makeLocalCertificates = async (
  dir: string,
  names: readonly string[],
  signal: AbortSignal,
): Promise<Certificates> => {
  refuseUnpermitted(names);
  const authority = await localAuthority(dir, signal);
  return certificatesIn(async (cwd) => {
    await makeLeaf(cwd, { authority, names }, signal);
    return authority.certFile;
  });
};

/** The local CA's certificate alone, its key left where it lies: what a browser that trusts it
 *  takes into its store. The CA is made in `dir` on first use. */
export const localCaCertificate = async (dir: string, signal: AbortSignal): Promise<string> => {
  const { certFile } = await localAuthority(dir, signal);
  return readFile(certFile, 'utf8');
};

/** `spki` is the base64 SHA-256 of the leaf's public key. */
export interface Trust {
  readonly ca: string;
  readonly spki: string;
}

interface EdgeCertificate {
  readonly key: string;
  readonly cert: string;
  readonly trust: Trust;
}

/** How the edge's leaf is signed: by the local CA in `localCa` if named, naming `host` too. */
export interface EdgeSigning {
  readonly localCa?: string | undefined;
  readonly host?: string | undefined;
}

/** A certificate for the edge, held in memory: its files are removed as soon as they are read.
 *  Signed by the local CA in `localCa`, when one is named; by a throwaway CA otherwise. */
export const makeEdgeCertificate = async (
  signal: AbortSignal,
  { localCa, host }: EdgeSigning = {},
): Promise<EdgeCertificate> => {
  const names = edgeNames(host);
  const certificates = await (localCa === undefined
    ? makeCertificates(signal, names)
    : makeLocalCertificates(localCa, names, signal));
  try {
    const { dir, caFile } = certificates;
    const [key, cert, ca] = await Promise.all([
      readFile(path.join(dir, 'key.pem'), 'utf8'),
      readFile(path.join(dir, 'cert.pem'), 'utf8'),
      readFile(caFile, 'utf8'),
    ]);
    const der = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
    const spki = createHash('sha256').update(der).digest('base64');
    return { key, cert, trust: { ca, spki } };
  } finally {
    await certificates.stop();
  }
};

/** Adds a CA to what this process's TLS clients trust, `fetch` and `WebSocket` included. */
export const trustCa = (ca: string): void => {
  setDefaultCACertificates([...getCACertificates('default'), ca]);
};

/** How a browser trusts the edge: the switches it launches with, and its contexts' option.
 *  WebKit's contexts are ephemeral, with no disk cache, so a new tab loads anew. */
export interface BrowserTrust {
  readonly args: readonly string[];
  readonly ignoreHTTPSErrors: boolean;
}

/** Chromium launched here checks the edge by its leaf's key, WebKit in the Linux image by the local
 *  CA; the rest have no CA switch, and the host's store would mean the Mac's keychain. */
export const browserTrust = (
  { spki }: Trust,
  browserName: string,
  contained = false,
): BrowserTrust => ({
  args: browserName === 'chromium' ? [`--ignore-certificate-errors-spki-list=${spki}`] : [],
  ignoreHTTPSErrors: contained ? browserName !== 'webkit' : browserName !== 'chromium',
});
