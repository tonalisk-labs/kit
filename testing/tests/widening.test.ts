// A widening's wait (stack/control.ts) is the run's queue, not the test's work: the test's watch
// for standing still (stuck.ts) pauses for it, as its timeout does, and goes again from the grant.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { holdTestTurn, holdTurn, testWatched, widenTestTurn } from '../src/stack/control.ts';
import { STILL_MS, watchProgress } from '../src/stuck.ts';
import { inRun, timeoutOf } from './gate-run.ts';
import { manualClock } from './manual-clock.ts';

await test('a widening test is never stuck while it waits for every slot, and is watched again once granted', async () =>
  inRun(async (turns) => {
    const other = await holdTurn(turns);
    const release = await holdTestTurn();
    const { clock, advance } = manualClock();
    const stuck: string[] = [];
    const progress = watchProgress({
      clock,
      spent: () => 0,
      stuck: (last) => {
        stuck.push(last);
      },
    });
    const widened = widenTestTurn(timeoutOf(180_000), progress);
    // The queue, however long: the test ahead holds a slot the widening waits for.
    advance(10 * STILL_MS);
    assert.deepEqual(stuck, [], 'not stuck in the queue');
    other();
    await widened;
    advance(STILL_MS - 1);
    assert.deepEqual(stuck, [], 'watched from the grant on');
    advance(1);
    assert.deepEqual(stuck, ['the wait for every CPU slot'], 'stuck once still past the grant');
    progress.stop();
    release();
  }));

await test("a widening pauses the running test's watch, as its fixture names it, and none after", async () =>
  inRun(async () => {
    const paused: string[] = [];
    const unwatched = testWatched({
      pause: (wait) => {
        paused.push(wait);
        return (): void => undefined;
      },
    });
    const release = await holdTestTurn();
    await widenTestTurn(timeoutOf(0));
    unwatched();
    release();
    const next = await holdTestTurn();
    await widenTestTurn(timeoutOf(0));
    next();
    assert.deepEqual(paused, ['the wait for every CPU slot'], 'the second test had no watch');
  }));
