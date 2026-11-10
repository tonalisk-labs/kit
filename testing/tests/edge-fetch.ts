// A request to the edge over HTTP/2, as the edge tests send it.
import { once } from 'node:events';
import type { ClientHttp2Session } from 'node:http2';

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly body: Buffer;
}

/** The edge's answer to a request over HTTP/2, its `:path` in `headers`, once its body arrives. */
export const fetchOver = async (
  session: ClientHttp2Session,
  headers: Readonly<Record<string, string>>,
): Promise<Answer> => {
  // Every request is sent whole: a stream left open for a body would hold the session open.
  const stream = session.request(headers, { endStream: true });
  const head = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
    stream.once('response', resolve);
  });
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(stream, 'end');
  const answered = await head;
  return { status: Number(answered[':status']), headers: answered, body: Buffer.concat(chunks) };
};
