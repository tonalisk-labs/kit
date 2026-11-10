// The edge's own answers, in either protocol: a head, and what it says in the origin's place as
// a fault asks (stack/contexts.ts).
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { constants, Http2ServerResponse } from 'node:http2';

import { type Fault, faultAnswer } from './contexts.ts';

/** An answer under way, an HTTP/1.1 exchange's or an HTTP/2 stream's. */
export type Outgoing = ServerResponse | Http2ServerResponse;

/** Sends an answer's head in either protocol; HTTP/2 has no reason phrase. */
export const writeHead = (
  outgoing: Outgoing,
  status: number,
  headers: OutgoingHttpHeaders = {},
): void => {
  if (outgoing instanceof Http2ServerResponse) {
    outgoing.writeHead(status, headers);
  } else {
    outgoing.writeHead(status, headers);
  }
};

/** What a captive portal or a misrouted proxy answers in the origin's place. */
const PORTAL_PAGE =
  '<!doctype html><html lang="en"><title>Sign in to the network</title><h1>Sign in to the network</h1></html>';

/** The start of a body the edge resets under, as a long JSON answer starts. */
const CUT_BODY = '{"items":[{"id":"';

/** Sends a body's first bytes, then resets the HTTP/2 stream with an error code, as a plain end
 *  would close it cleanly, or drops the HTTP/1.1 connection. */
const cutOff = (outgoing: Outgoing): void => {
  if (outgoing instanceof Http2ServerResponse) {
    outgoing.write(CUT_BODY, () => {
      outgoing.stream.close(constants.NGHTTP2_INTERNAL_ERROR);
    });
  } else {
    outgoing.write(CUT_BODY, () => {
      outgoing.destroy();
    });
  }
};

/** Answers in the origin's place as `fault` says; a hang is held open until the client gives up. */
export const answerFault = (fault: Fault, outgoing: Outgoing): void => {
  if (fault.kind === 'hang') {
    return;
  }
  if (fault.kind === 'page') {
    writeHead(outgoing, 200, { 'content-type': 'text/html; charset=utf-8' });
    outgoing.end(PORTAL_PAGE);
    return;
  }
  if (fault.kind === 'reset') {
    // A length the body never reaches: the client reads its first bytes, then the reset.
    writeHead(outgoing, 200, { 'content-type': 'application/json', 'content-length': '65536' });
    cutOff(outgoing);
    return;
  }
  const { status, headers, body } = faultAnswer(fault);
  writeHead(outgoing, status, headers);
  outgoing.end(body);
};
