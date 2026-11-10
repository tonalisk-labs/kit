// Lighthouse's categories, each against its own minimum: accessibility, best practices and SEO
// held at 100, since nothing trades against them, and performance, scored from timings a busy
// machine stretches, reported under kit's minimum score.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { minimumScore } from '../src/perf/budgets.ts';
import type { FlowResult } from '../src/perf/lighthouse.ts';
import { belowMinimum, type Scored, scoresOf, timedBelowMinimum } from '../src/perf/scores.ts';

/** Lighthouse's own result is what the checks take: the type checker holds it to `Scored`. */
export const scoredFrom = (result: FlowResult): Scored => result;

/** A one-step flow whose categories scored as given, out of 1, each failing one audit below 1. */
const flowScoring = (scores: Readonly<Record<string, number>>): Scored => {
  const categories = Object.fromEntries(
    Object.entries(scores).map(([id, score]) => [
      id,
      { id, score, auditRefs: [{ id: `${id}-audit` }] },
    ]),
  );
  const audits = Object.fromEntries(
    Object.entries(scores).map(([id, score]) => [
      `${id}-audit`,
      { id: `${id}-audit`, title: `the ${id} audit`, score },
    ]),
  );
  return { steps: [{ name: 'home', lhr: { categories, audits } }] };
};

await test('accessibility, best practices and SEO are held at 100, performance at 90', () => {
  assert.deepEqual(
    ['accessibility', 'best-practices', 'seo', 'performance'].map((id) => minimumScore(id)),
    [100, 100, 100, 90],
  );
});

await test('a 99 in accessibility fails, with the audit that cost it', () => {
  const result = flowScoring({ accessibility: 0.99, performance: 0.91 });
  assert.deepEqual(belowMinimum(result), [
    'home: accessibility scored 99, under 100; failing: accessibility-audit: the accessibility audit',
  ]);
});

await test('perfect categories and a performance score at its minimum pass', () => {
  const result = flowScoring({ accessibility: 1, 'best-practices': 1, seo: 1, performance: 0.9 });
  assert.deepEqual(belowMinimum(result), []);
  assert.deepEqual(scoresOf(result).get('home'), {
    accessibility: 100,
    'best-practices': 100,
    seo: 100,
    performance: 90,
  });
});

/** Lighthouse's own word for a score it could not give, as its JSON results carry it. */
const parsed: unknown = JSON.parse('null');
const NO_SCORE = parsed === null ? parsed : 0;

await test('a category with no score counts as 0, and an audit without one is not named', () => {
  const result: Scored = {
    steps: [
      {
        name: 'home',
        lhr: {
          categories: {
            seo: { id: 'seo', score: NO_SCORE, auditRefs: [{ id: 'unscored' }, { id: 'absent' }] },
          },
          audits: {
            unscored: { id: 'unscored', title: 'an audit with no score', score: NO_SCORE },
          },
        },
      },
    ],
  };
  assert.deepEqual(belowMinimum(result), ['home: seo scored 0, under 100; failing: ']);
  assert.deepEqual(scoresOf(result).get('home'), { seo: 0 });
});

await test('performance under its minimum is reported, never held', () => {
  const result = flowScoring({ accessibility: 1, performance: 0.42 });
  assert.deepEqual(belowMinimum(result), []);
  assert.deepEqual(timedBelowMinimum(result), [
    'home: performance scored 42, under 90; failing: performance-audit: the performance audit',
  ]);
  assert.deepEqual(timedBelowMinimum(flowScoring({ performance: 0.95, seo: 0.5 })), []);
});
