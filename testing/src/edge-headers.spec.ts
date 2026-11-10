// The guard: every class of answer carries the headers the target's production edge adds, as the
// test edge sends them. A page, the first script it loads, a page that is missing, and the API
// are each asked for, and each must carry every header of its classes with its exact value. A
// target whose adapter declares no such headers has none to hold, which the test notes.
import { edgeHeadersFor, loadAdapter } from './adapter.ts';
import { discover } from './discover.ts';
import { apiTest, expect } from './fixtures.ts';

/** A path no site serves, for the class a missing page's answer takes. */
const MISSING = '/kit-edge-headers-missing';

/** The first script `/` loads from the site itself. */
const SCRIPT = /<script[^>]+src="(?<src>\/[^"]+\.js)"/u;

/** The headers of `path`'s answer that its classes name but it lacks or gives another value. */
const lacking = (
  answer: Headers,
  wanted: Readonly<Record<string, string>>,
  path: string,
): string[] =>
  Object.entries(wanted)
    .filter(([name, value]) => answer.get(name) !== value)
    .map(([name, value]) => `${path}: ${name} is ${answer.get(name) ?? 'missing'}, not ${value}`);

apiTest(
  'each class of answer carries the headers its production edge adds',
  { tag: '@api' },
  async ({ stack, site }, testInfo) => {
    const target = discover().find(({ name }) => name === site);
    const adapter = await loadAdapter(target === undefined ? undefined : target.adapter);
    const edge = adapter === undefined ? undefined : adapter.edgeHeaders;
    if (edge === undefined) {
      testInfo.annotations.push({ type: 'note', description: `${site} declares no edge headers` });
      return;
    }
    const home = await fetch(new URL('/', stack.baseURL));
    const [, script] = SCRIPT.exec(await home.text()) ?? [];
    const paths = [
      '/',
      ...(script === undefined ? [] : [script]),
      MISSING,
      ...(stack.apiPrefix === undefined ? [] : [`${stack.apiPrefix}/`]),
    ];
    expect(paths.length, 'the home page loads a script of its own').toBeGreaterThan(2);
    const answers = await Promise.all(
      paths.map(async (path) => {
        const answer = await fetch(new URL(path, stack.baseURL));
        if (answer.body !== null) {
          await answer.body.cancel();
        }
        return lacking(answer.headers, edgeHeadersFor(edge, path), path);
      }),
    );
    expect(answers.flat(), 'every answer carries its classes of headers').toEqual([]);
  },
);
