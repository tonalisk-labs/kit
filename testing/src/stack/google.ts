import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { isObject } from '../unknown.ts';
import { IDLE_CONNECTION_MS } from './edge.ts';
import type { Service } from './process.ts';
import { routeMatches } from './route-key.ts';

export interface FakeGoogle extends Service {
  /** The API base and the token endpoint's origin a backend is pointed at. */
  readonly url: string;
}

/** An event as Calendar stores it, with the fields a booking backend reads. */
interface Event {
  readonly id: string;
  readonly iCalUID: string;
  status: string;
  sequence: number;
  readonly created: string;
  updated: string;
  summary: string;
  description: string;
  start: { readonly dateTime: string };
  end: { readonly dateTime: string };
  attendees: readonly { readonly email: string; readonly displayName?: string }[];
  hangoutLink: string | undefined;
  extendedProperties: { readonly private: Readonly<Record<string, string>> };
}

interface Interval {
  readonly start: string;
  readonly end: string;
}

interface State {
  readonly tokens: Set<string>;
  readonly events: Map<string, Event>;
  readonly busy: Interval[];
  /** Operations told to fail, each with the status its next calls answer and how many. */
  readonly failing: Map<string, { readonly status: number; times: number }>;
  /** The spans tests have claimed, so tests running at once never pick overlapping times. */
  readonly claimed: Map<string, Interval | undefined>;
}

type Reply = readonly [status: number, body: unknown];

interface Call {
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  readonly body: string;
}

type Handler = (state: State, call: Call) => Reply;

const problem = (status: number, message: string): Reply => [
  status,
  { error: { code: status, message } },
];

/** The path's last segment: an event's id. */
const last = (call: Call): string => decodeURIComponent(call.segments.at(-1) ?? '');

const json = (body: string): Record<string, unknown> => {
  const parsed: unknown = body === '' ? {} : JSON.parse(body);
  return isObject(parsed) ? parsed : {};
};

const overlaps = (interval: Interval, from: string, to: string): boolean =>
  Date.parse(interval.start) < Date.parse(to) && Date.parse(interval.end) > Date.parse(from);

const token = (state: State, call: Call): Reply => {
  const form = new URLSearchParams(call.body);
  if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') === null) {
    return [400, { error: 'invalid_grant' }];
  }
  const issued = `ya29.fake-${randomBytes(12).toString('hex')}`;
  state.tokens.add(issued);
  return [200, { access_token: issued, expires_in: 3600, token_type: 'Bearer' }];
};

/** Busy is what a free/busy query shows: the blocks set, and every event not cancelled. */
const freeBusy = (state: State, call: Call): Reply => {
  const { timeMin, timeMax, items } = json(call.body);
  const [from, to] = [String(timeMin), String(timeMax)];
  const calendars = (Array.isArray(items) ? items : []).map((item: unknown) =>
    isObject(item) ? String(item['id']) : '',
  );
  const events = [...state.events.values()].filter((event) => event.status !== 'cancelled');
  const busy = [
    ...state.busy,
    ...events.map((event) => ({ start: event.start.dateTime, end: event.end.dateTime })),
  ].filter((interval) => overlaps(interval, from, to));
  return [200, { calendars: Object.fromEntries(calendars.map((id) => [id, { busy }])) }];
};

const meetCode = (): string => {
  const letters = randomBytes(10).toString('hex').replaceAll(/\d/gu, 'x');
  return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7, 10)}`;
};

const privateOf = (body: Record<string, unknown>): Record<string, string> => {
  const { extendedProperties } = body;
  const properties = isObject(extendedProperties) ? extendedProperties['private'] : undefined;
  return isObject(properties)
    ? Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, String(value)]))
    : {};
};

const guestsOf = (body: Record<string, unknown>): Event['attendees'] =>
  Array.isArray(body['attendees'])
    ? body['attendees'].filter(isObject).map((guest) => ({
        email: String(guest['email']),
        displayName: typeof guest['displayName'] === 'string' ? guest['displayName'] : '',
      }))
    : [];

const conferenceOf = (call: Call, body: Record<string, unknown>): string | undefined =>
  call.query.get('conferenceDataVersion') === '1' && isObject(body['conferenceData'])
    ? `https://meet.google.com/${meetCode()}`
    : undefined;

const when = (value: unknown): { dateTime: string } => ({
  dateTime: isObject(value) ? String(value['dateTime']) : '',
});

/** An insert refuses an id Calendar already holds, cancelled ones included, as Google does. */
const insert = (state: State, call: Call): Reply => {
  if (call.query.get('sendUpdates') !== 'none') {
    return problem(400, 'this fake Calendar sends no invitations: pass sendUpdates=none');
  }
  const body = json(call.body);
  const id = typeof body['id'] === 'string' ? body['id'] : randomBytes(13).toString('hex');
  if (state.events.has(id)) {
    return problem(409, 'The requested identifier already exists.');
  }
  const now = new Date().toISOString();
  const event: Event = {
    id,
    iCalUID: `${id}@google.com`,
    status: 'confirmed',
    sequence: 0,
    created: now,
    updated: now,
    summary: typeof body['summary'] === 'string' ? body['summary'] : '',
    description: typeof body['description'] === 'string' ? body['description'] : '',
    start: when(body['start']),
    end: when(body['end']),
    attendees: guestsOf(body),
    hangoutLink: conferenceOf(call, body),
    extendedProperties: { private: privateOf(body) },
  };
  state.events.set(id, event);
  return [200, event];
};

const read = (state: State, call: Call): Reply => {
  const event = state.events.get(last(call));
  return event === undefined ? problem(404, 'Not Found') : [200, event];
};

/** Changes the members sent, as Google's patch does; private properties are merged. */
const patch = (state: State, call: Call): Reply => {
  const event = state.events.get(last(call));
  if (event === undefined) {
    return problem(404, 'Not Found');
  }
  if (call.query.get('sendUpdates') !== 'none') {
    return problem(400, 'this fake Calendar sends no invitations: pass sendUpdates=none');
  }
  const body = json(call.body);
  const { status, summary, description } = body;
  Object.assign(
    event,
    typeof status === 'string' ? { status } : {},
    typeof summary === 'string' ? { summary } : {},
    typeof description === 'string' ? { description } : {},
    Array.isArray(body['attendees']) ? { attendees: guestsOf(body) } : {},
    event.hangoutLink === undefined ? { hangoutLink: conferenceOf(call, body) } : {},
    isObject(body['extendedProperties'])
      ? {
          extendedProperties: {
            private: Object.assign(
              structuredClone(event.extendedProperties.private),
              privateOf(body),
            ),
          },
        }
      : {},
  );
  event.updated = new Date().toISOString();
  return [200, event];
};

/** A deleted event keeps its id, as a cancelled one. */
const remove = (state: State, call: Call): Reply => {
  const event = state.events.get(last(call));
  if (event === undefined || event.status === 'cancelled') {
    return problem(410, 'Resource has been deleted');
  }
  event.status = 'cancelled';
  event.updated = new Date().toISOString();
  return [204, undefined];
};

/** Events whose private property matches, which end after `timeMin` and start before any
 *  `timeMax`, cancelled ones left out. */
const list = (state: State, call: Call): Reply => {
  const [key = '', value = ''] = (call.query.get('privateExtendedProperty') ?? '').split('=');
  const since = Date.parse(call.query.get('timeMin') ?? '');
  const until = Date.parse(call.query.get('timeMax') ?? '');
  const items = [...state.events.values()].filter(
    (event) =>
      event.status !== 'cancelled' &&
      event.extendedProperties.private[key] === value &&
      Date.parse(event.end.dateTime) > since &&
      (Number.isNaN(until) || Date.parse(event.start.dateTime) < until),
  );
  return [200, { items }];
};

/** Sets one private property of an event, as an older booking would have it: `{id, key, value}`. */
const note = (state: State, call: Call): Reply => {
  const { id, key, value } = json(call.body);
  const event = state.events.get(String(id));
  if (event === undefined) {
    return problem(404, 'Not Found');
  }
  const changed = Object.fromEntries([[String(key), String(value)]]);
  event.extendedProperties = {
    private: Object.assign(structuredClone(event.extendedProperties.private), changed),
  };
  return [204, undefined];
};

/** Moves an event, as the host would in the calendar: `{id, start, end}`. */
const move = (state: State, call: Call): Reply => {
  const { id, start, end } = json(call.body);
  const event = state.events.get(String(id));
  if (event === undefined) {
    return problem(404, 'Not Found');
  }
  Object.assign(event, { start: { dateTime: String(start) }, end: { dateTime: String(end) } });
  return [204, undefined];
};

const block = (state: State, call: Call): Reply => {
  const { start, end } = json(call.body);
  state.busy.push({ start: String(start), end: String(end) });
  return [204, undefined];
};

const fail = (state: State, call: Call): Reply => {
  const { operation, status, times } = json(call.body);
  state.failing.set(String(operation), {
    status: Number(status),
    times: typeof times === 'number' ? times : 1,
  });
  return [204, undefined];
};

/** The span a meeting keeps free around its start, `before` and `after` in minutes with buffers
 *  included; none for a start that is not an instant. */
const spanOf = (start: string, before: unknown, after: unknown): Interval | undefined => {
  const at = Date.parse(start);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return {
    start: new Date(at - Number(before ?? 0) * 60_000).toISOString(),
    end: new Date(at + Number(after ?? 0) * 60_000).toISOString(),
  };
};

/** The first of `starts` whose span no claimed span overlaps (nor the same start), claimed now
 *  in one call. */
const claim = (state: State, call: Call): Reply => {
  const { starts, before, after } = json(call.body);
  const free = (start: string): boolean => {
    const span = spanOf(start, before, after);
    return [...state.claimed].every(
      ([taken, other]) =>
        taken !== start &&
        (span === undefined || other === undefined || !overlaps(other, span.start, span.end)),
    );
  };
  const start = (Array.isArray(starts) ? starts : []).map(String).find((each) => free(each));
  if (start === undefined) {
    return [409, undefined];
  }
  state.claimed.set(start, spanOf(start, before, after));
  return [200, { start }];
};

const EVENTS = 'calendar/v3/calendars/*/events';

/** Method, path with `*` for one segment, the operation's name for `/fake/fail`, and handler. */
const ROUTES: readonly (readonly [string, string, Handler])[] = [
  ['POST /token', 'token', token],
  ['POST /calendar/v3/freeBusy', 'freeBusy', freeBusy],
  [`POST /${EVENTS}`, 'insert', insert],
  [`GET /${EVENTS}`, 'list', list],
  [`GET /${EVENTS}/*`, 'get', read],
  [`PATCH /${EVENTS}/*`, 'patch', patch],
  [`DELETE /${EVENTS}/*`, 'delete', remove],
  ['POST /fake/busy', '', block],
  ['POST /fake/fail', '', fail],
  ['POST /fake/claim', '', claim],
  ['POST /fake/move', '', move],
  ['POST /fake/private', '', note],
  ['GET /fake/events/*', '', read],
];

/** A failure set for this operation, spent by one call. */
const injected = (state: State, operation: string): Reply | undefined => {
  const failure = state.failing.get(operation);
  if (failure === undefined || failure.times <= 0) {
    return undefined;
  }
  failure.times -= 1;
  return problem(failure.status, `the fake was told to fail ${operation}`);
};

const authorised = (state: State, request: IncomingMessage): boolean =>
  state.tokens.has((request.headers.authorization ?? '').replace(/^Bearer /u, ''));

const route = async (state: State, request: IncomingMessage, url: URL): Promise<Reply> => {
  const segments = url.pathname.split('/').slice(1);
  const key = `${request.method ?? 'GET'} /${segments.join('/')}`;
  const found = ROUTES.find(([pattern]) => routeMatches(pattern, key));
  const chunks = await Array.fromAsync(request, (chunk: Buffer) => chunk.toString('utf8'));
  if (found === undefined) {
    return problem(404, `the fake Calendar has no ${key}`);
  }
  const [, operation, handler] = found;
  if (operation !== '' && operation !== 'token' && !authorised(state, request)) {
    return problem(401, 'Request had invalid authentication credentials.');
  }
  return (
    (operation === '' ? undefined : injected(state, operation)) ??
    handler(state, { segments, query: url.searchParams, body: chunks.join('') })
  );
};

const respond = (response: ServerResponse, [status, body]: Reply): void => {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
  response.end(JSON.stringify(body));
};

/** A Google Calendar and OAuth token endpoint answering from memory only what a booking backend
 *  asks (token refresh, freeBusy, events); tests steer it through the `/fake/` routes. */
export const startFakeGoogle = async (): Promise<FakeGoogle> => {
  const server = createServer({ keepAliveTimeout: IDLE_CONNECTION_MS });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
  const state: State = {
    tokens: new Set(),
    events: new Map(),
    busy: [],
    failing: new Map(),
    claimed: new Map(),
  };
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    route(state, request, new URL(request.url ?? '/', url))
      .then((reply) => {
        respond(response, reply);
      })
      .catch((error: unknown) => {
        respond(response, problem(500, String(error)));
      });
  });
  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  };
  return { url, stop };
};

const control = async (url: string, path: string, body: unknown): Promise<number> => {
  const response = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) });
  if (response.status !== 204 && response.status !== 409) {
    throw new Error(`the fake Calendar answered ${String(response.status)} to ${path}`);
  }
  return response.status;
};

/** The minutes a claimed meeting keeps around its start: before it, and after it starts. */
interface Span {
  readonly before: number;
  readonly after: number;
}

/** A claim of the start alone. */
const NO_SPAN: Span = { before: 0, after: 0 };

const firstUnclaimed = async (
  url: string,
  starts: readonly string[],
  span: Span,
): Promise<string> => {
  const response = await fetch(`${url}/fake/claim`, {
    method: 'POST',
    body: JSON.stringify({ starts, before: span.before, after: span.after }),
  });
  if (response.status === 409) {
    throw new Error('every free start is claimed by another test');
  }
  const body: unknown = await response.json();
  if (response.status !== 200 || !isObject(body) || typeof body['start'] !== 'string') {
    throw new Error(`the fake Calendar answered ${String(response.status)} to /fake/claim`);
  }
  return body['start'];
};

/** An event as a test reads it back. */
export interface CalendarEvent {
  readonly id: string;
  readonly iCalUID: string;
  readonly status: string;
  readonly summary: string;
  readonly start: { readonly dateTime: string };
  readonly hangoutLink?: string;
  readonly extendedProperties: { readonly private: Readonly<Record<string, string>> };
  readonly attendees: readonly { readonly email: string; readonly displayName?: string }[];
}

const isEvent = (value: unknown): value is CalendarEvent =>
  isObject(value) && typeof value['id'] === 'string' && typeof value['iCalUID'] === 'string';

/** Steers and reads the fake Calendar a stack runs, from a test. */
export const calendar = (url: string) =>
  ({
    /** Blocks time as another event in the calendar would. */
    busy: async (start: string, end: string): Promise<void> => {
      await control(url, '/fake/busy', { start, end });
    },
    /** The next `times` calls of `operation` answer `status`. */
    fail: async (operation: string, status: number, times = 1): Promise<void> => {
      await control(url, '/fake/fail', { operation, status, times });
    },
    /** Moves an event to another time, as the host would. */
    move: async (id: string, start: string, end: string): Promise<void> => {
      await control(url, '/fake/move', { id, start, end });
    },
    /** Sets one private property of an event, as an older booking would have it. */
    note: async (id: string, key: string, value: string): Promise<void> => {
      await control(url, '/fake/private', { id, key, value });
    },
    /** One of `starts` for this test alone: tests sharing the calendar never collide. A `span`
     *  keeps a longer meeting's buffers and length clear of every other claim. */
    claim: async (starts: readonly string[], span: Span = NO_SPAN): Promise<string> =>
      firstUnclaimed(url, starts, span),
    /** An event as Calendar holds it, or undefined. */
    event: async (id: string): Promise<CalendarEvent | undefined> => {
      const response = await fetch(`${url}/fake/events/${encodeURIComponent(id)}`);
      const body: unknown = await response.json();
      return response.ok && isEvent(body) ? body : undefined;
    },
  }) as const;
