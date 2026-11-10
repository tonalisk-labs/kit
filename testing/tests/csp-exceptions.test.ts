// An engine's own CSP violation, named as no fault of the target: let pass on that engine alone,
// matched whole, while it stands; refused, naming why, once its day has passed, when its day is
// more than half a year away, or when its console line is no CSP line.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type CspException, excepted, exceptionProblems } from '../src/csp-exceptions.ts';

const WEBKIT_LINE =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";

/** WebKit 27.2's violation as a page makes a <select>, its console line and day to look again. */
const select = (reviewBy: string, line = WEBKIT_LINE): CspException => ({
  engine: 'webkit',
  directive: 'style-src-attr',
  blocked: 'inline',
  console: line,
  reason: 'WebKit 27.2 reports a violation as a page makes any <select>, with no style written.',
  bug: 'bugs/webkit-select-csp.md',
  reviewBy,
});

const SELECT = select('2026-12-06');
const VIOLATION = 'CSP violation: style-src-attr blocked inline';
const ON_WEBKIT = { engine: 'webkit', today: '2026-11-06' };

await test('the violation and its engine’s own line pass on that engine alone, matched whole', () => {
  assert.equal(excepted([SELECT], ON_WEBKIT, VIOLATION), true);
  assert.equal(excepted([SELECT], ON_WEBKIT, WEBKIT_LINE), true);
  assert.equal(excepted([SELECT], { engine: 'chromium', today: '2026-11-06' }, VIOLATION), false);
  assert.equal(excepted([SELECT], { engine: 'firefox', today: '2026-11-06' }, WEBKIT_LINE), false);
  for (const other of [
    'CSP violation: style-src-elem blocked inline',
    'CSP violation: style-src-attr blocked https://cdn.test/a.css',
    'CSP violation: script-src blocked inline',
    `${VIOLATION} `,
    `${WEBKIT_LINE} And more.`,
  ]) {
    assert.equal(excepted([SELECT], ON_WEBKIT, other), false, other);
  }
  assert.equal(excepted([], ON_WEBKIT, VIOLATION), false);
});

await test('an exception stands until its day, and is refused, naming why, once the day has passed', () => {
  assert.deepEqual(exceptionProblems([SELECT], '2026-12-06'), []);
  assert.deepEqual(exceptionProblems([SELECT], '2026-11-06'), []);
  assert.deepEqual(exceptionProblems([SELECT], '2026-12-07'), [
    `CSP exception refused: webkit's "${VIOLATION}": it was to be looked at again by 2026-12-06 (${SELECT.bug})`,
  ]);
  assert.equal(excepted([SELECT], { engine: 'webkit', today: '2026-12-07' }, VIOLATION), false);
  for (const reviewBy of ['', '6 December', '2026-13-40', '2026-12-6']) {
    assert.match(
      exceptionProblems([select(reviewBy)], '2026-11-06').join(''),
      /it has no day, as YYYY-MM-DD, to be looked at again/u,
      reviewBy,
    );
  }
});

await test('an exception whose day is more than half a year away is refused, so none is parked', () => {
  assert.deepEqual(exceptionProblems([select('2027-05-06')], '2026-11-06'), []);
  for (const reviewBy of ['2027-06-01', '9999-12-31']) {
    const far = select(reviewBy);
    assert.deepEqual(exceptionProblems([far], '2026-11-06'), [
      `CSP exception refused: webkit's "${VIOLATION}": its day to be looked at again, ${reviewBy}, is more than half a year away (${far.bug})`,
    ]);
    assert.equal(excepted([far], ON_WEBKIT, VIOLATION), false, reviewBy);
  }
});

await test('an exception lets pass only a CSP line, as each engine words one, and no other line', () => {
  for (const line of [
    WEBKIT_LINE,
    "Applying inline style violates the following Content Security Policy directive 'style-src 'self''.",
    'Content-Security-Policy: The page’s settings blocked an inline style (style-src-attr).',
  ]) {
    assert.deepEqual(exceptionProblems([select('2026-12-06', line)], '2026-11-06'), [], line);
  }
  const hatch = select(
    '2026-12-06',
    'ResizeObserver loop completed with undelivered notifications.',
  );
  assert.match(
    exceptionProblems([hatch], '2026-11-06').join(''),
    /names no Content Security Policy/u,
  );
  assert.equal(excepted([hatch], ON_WEBKIT, hatch.console), false);
  assert.equal(excepted([hatch], ON_WEBKIT, VIOLATION), false);
});
