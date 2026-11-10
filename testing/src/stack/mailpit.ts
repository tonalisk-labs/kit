import { once } from 'node:events';

import { isObject } from '../unknown.ts';
import { container } from './containers.ts';
import type { Service } from './process.ts';
import type { ContainerSpec } from './runtime.ts';
import { makeCertificates } from './tls.ts';

export interface MailSink extends Service {
  readonly smtpHost: string;
  readonly smtpPort: number;
  /** The throwaway CA that signed Mailpit's certificate, for the sender to trust. */
  readonly caFile: string;
  /** Mailpit's web and REST origin. */
  readonly api: string;
}

const IMAGE =
  'axllent/mailpit:v1.31.3@sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d';
const SMTP = 1025;
const HTTP = 8025;
const CERTS = '/certs';
const READY = ['[smtpd] starting on', '[http] accessible via'];

/** Mailpit's container, its certificate and key read from `certificates`. */
const specOf = (certificates: string): ContainerSpec => ({
  image: IMAGE,
  ports: [SMTP, HTTP],
  ready: READY,
  readyInAnyOrder: true,
  files: [certificates, CERTS],
  env: {
    MP_SMTP_AUTH_ACCEPT_ANY: '1',
    MP_SMTP_TLS_CERT: `${CERTS}/cert.pem`,
    MP_SMTP_TLS_KEY: `${CERTS}/key.pem`,
    MP_SMTP_REQUIRE_STARTTLS: '1',
    // Off until a test sets a trigger: only then does the relay refuse anything.
    MP_ENABLE_CHAOS: 'true',
  },
  // The least machine Apple's container makes: at 10 workers it peaked at 44 MiB, with no stall.
  machine: { memory: 200, cpus: 4 },
});

/** Mailpit at its pinned release, accepting any credentials only after STARTTLS with a throwaway
 *  CA's certificate, so a sender takes its real TLS and verification path. */
export const startMailpit = async (signal: AbortSignal): Promise<MailSink> => {
  const certificates = await makeCertificates(signal);
  try {
    const server = await container(specOf(certificates.dir), signal);
    const stop = async (): Promise<void> => {
      try {
        await server.stop();
      } finally {
        await certificates.stop();
      }
    };
    const smtp = server.address(SMTP);
    const http = server.address(HTTP);
    return {
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      caFile: certificates.caFile,
      api: `http://${http.host}:${String(http.port)}`,
      stop,
    };
  } catch (error) {
    await certificates.stop();
    throw error;
  }
};

interface Address {
  readonly Address: string;
  readonly Name: string;
}

/** A message as Mailpit lists it. */
export interface Summary {
  readonly ID: string;
  readonly From: Address;
  readonly To: readonly Address[];
  readonly Subject: string;
  /** The start of the text body, as Mailpit lists it. */
  readonly Snippet?: string;
}

/** A message as Mailpit reads it, with its parsed bodies. */
export interface Message extends Summary {
  readonly Text: string;
  readonly HTML: string;
}

const isSummary = (value: unknown): value is Summary =>
  isObject(value) && typeof value['ID'] === 'string' && Array.isArray(value['To']);

const isMessage = (value: unknown): value is Message =>
  isSummary(value) && 'Text' in value && typeof value.Text === 'string';

const json = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Mailpit answered ${String(response.status)} for ${url}`);
  }
  return response.json();
};

const summaries = (body: unknown): Summary[] =>
  isObject(body) && Array.isArray(body['messages']) ? body['messages'].filter(isSummary) : [];

const addressedTo = (summary: Summary, recipient: string): boolean =>
  summary.To.some(({ Address }) => Address.toLowerCase() === recipient.toLowerCase());

/** Makes the relay refuse every recipient with `code`, or with probability 0 accept them again. It
 *  refuses everyone's mail, so only a test that owns its stack (`@exclusive`) may use it. */
const refuse = async (api: string, code: number, probability: number): Promise<void> => {
  const trigger = { ErrorCode: code, Probability: probability };
  const response = await fetch(`${api}/api/v1/chaos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Recipient: trigger }),
  });
  if (!response.ok) {
    throw new Error(`Mailpit refused the chaos trigger: ${String(response.status)}`);
  }
};

const forget = async (api: string, recipient: string): Promise<void> => {
  const query = new URLSearchParams({ query: `to:"${recipient}"` });
  const response = await fetch(`${api}/api/v1/search?${query.toString()}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`Mailpit answered ${String(response.status)} deleting mail to ${recipient}`);
  }
};

/** Reads the parsed messages a Mailpit holds, through its REST API. */
export const mailbox = (api: string) =>
  ({
    list: async (): Promise<Summary[]> => summaries(await json(`${api}/api/v1/messages`)),
    /** Clears the box of `recipient`, for a test that reuses an address run after run. */
    forget: async (recipient: string): Promise<void> => forget(api, recipient),
    /** Refuses every recipient with `code` until `acceptRecipients`; `@exclusive` tests only. */
    refuseRecipients: async (code: number): Promise<void> => refuse(api, code, 100),
    acceptRecipients: async (): Promise<void> => refuse(api, 451, 0),
    read: async (id: string): Promise<Message> => {
      const body = await json(`${api}/api/v1/message/${encodeURIComponent(id)}`);
      if (!isMessage(body)) {
        throw new TypeError(`Mailpit returned no message ${id}`);
      }
      return body;
    },
    /** The first message to `recipient`, waiting for it through Mailpit's event stream. */
    waitFor: async (recipient: string): Promise<Summary> => {
      const [first] = await arrivals(api, { recipient, mentioning: undefined }, 1);
      if (first === undefined) {
        throw new Error(`no message to ${recipient} arrived`);
      }
      return first;
    },
    /** The first `count` messages to `recipient`, however many are still to arrive; `mentioning`
     *  keeps those whose text starts by naming it, where several senders share a box. */
    waitForCount: async (
      recipient: string,
      count: number,
      mentioning?: string,
    ): Promise<Summary[]> => arrivals(api, { recipient, mentioning }, count),
  }) as const;

interface Wanted {
  readonly recipient: string;
  readonly mentioning: string | undefined;
}

const wantedBy = (summary: Summary, { recipient, mentioning }: Wanted): boolean =>
  addressedTo(summary, recipient) &&
  (mentioning === undefined || (summary.Snippet ?? '').includes(mentioning));

/** The summary a Mailpit event carries of a new message, if it is one. */
const newSummary = (data: unknown): Summary | undefined => {
  const event: unknown = JSON.parse(String(data));
  const summary = isObject(event) && event['Type'] === 'new' ? event['Data'] : undefined;
  return isSummary(summary) ? summary : undefined;
};

/** The messages Mailpit already holds that `wanted` asks for. */
const searched = async (api: string, wanted: Wanted): Promise<Summary[]> => {
  const terms = wanted.mentioning === undefined ? '' : ` "${wanted.mentioning}"`;
  const query = new URLSearchParams({ query: `to:"${wanted.recipient}"${terms}` });
  const listed = summaries(await json(`${api}/api/v1/search?${query.toString()}`));
  return listed.filter((one) => wantedBy(one, wanted));
};

/** `promise`, rejected once MAIL_WAIT_MS pass: a mail that never comes fails like an assertion
 *  that never holds, not by hanging. */
const bounded = async <Value>(
  { promise, reject }: Pick<PromiseWithResolvers<Value>, 'promise' | 'reject'>,
  missing: string,
): Promise<Value> => {
  const budget = setTimeout(() => {
    reject(new Error(`${missing} within ${String(MAIL_WAIT_MS)} ms`));
  }, MAIL_WAIT_MS);
  try {
    return await promise;
  } finally {
    clearTimeout(budget);
  }
};

/** The stream opens before the inbox is searched, so a message landing in between is not missed. */
const arrivals = async (api: string, wanted: Wanted, count: number): Promise<Summary[]> => {
  const { recipient } = wanted;
  const events = new WebSocket(`${api.replace(/^http/u, 'ws')}/api/events`);
  try {
    await once(events, 'open');
    const found = new Map<string, Summary>();
    const settled = Promise.withResolvers<Summary[]>();
    const add = (summary: Summary): void => {
      found.set(summary.ID, summary);
      if (found.size >= count) {
        settled.resolve([...found.values()].slice(0, count));
      }
    };
    events.addEventListener('message', ({ data }) => {
      const summary = newSummary(data);
      if (summary !== undefined && wantedBy(summary, wanted)) {
        add(summary);
      }
    });
    events.addEventListener('close', () => {
      settled.reject(
        new Error(
          `Mailpit's event stream closed with ${String(found.size)} of ${String(count)} messages to ${recipient}`,
        ),
      );
    });
    for (const summary of await searched(api, wanted)) {
      add(summary);
    }
    return await bounded(settled, `no ${String(count)} messages to ${recipient}`);
  } finally {
    events.close();
  }
};

/** How long a mail may take: the backend's outbox drains it within seconds. */
const MAIL_WAIT_MS = 30_000;
