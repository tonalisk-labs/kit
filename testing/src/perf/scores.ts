// What a Lighthouse flow scored, read apart from Lighthouse itself, which only running a flow loads.
import { minimumScore } from './budgets.ts';

/** What these read of a flow's result (`FlowResult`): each step's categories and audits. */
export interface Scored {
  readonly steps: readonly {
    readonly name: string;
    readonly lhr: {
      readonly categories: Readonly<
        Record<
          string,
          {
            readonly id: string;
            readonly score: number | null;
            readonly auditRefs: readonly { readonly id: string }[];
          }
        >
      >;
      readonly audits: Readonly<
        Record<
          string,
          { readonly id: string; readonly title: string; readonly score: number | null }
        >
      >;
    };
  }[];
}

/** Categories scored from how long the page took on this machine: a busy machine scores them
 *  lower whatever the page does, so they are reported, never held. */
export const TIMED_CATEGORIES: ReadonlySet<string> = new Set(['performance']);

/** Each step's category scores under their minimum, the timed ones or the rest, with the audits
 *  that failed in it. */
const under = (result: Scored, timed: boolean): string[] =>
  result.steps.flatMap(({ name, lhr }) =>
    Object.values(lhr.categories)
      .filter(({ id }) => TIMED_CATEGORIES.has(id) === timed)
      .filter(({ id, score }) => (score ?? 0) * 100 < minimumScore(id))
      .map(({ id, score, auditRefs }) => {
        const failed = auditRefs
          .map((ref) => lhr.audits[ref.id])
          .filter((audit) => audit !== undefined && audit.score !== null && audit.score < 1)
          .map((audit) => (audit === undefined ? '' : `${audit.id}: ${audit.title}`));
        return `${name}: ${id} scored ${String(Math.round((score ?? 0) * 100))}, under ${String(minimumScore(id))}; failing: ${failed.join('; ')}`;
      }),
  );

/** What is held: each step's categories under their minimum that no busy machine moves. */
export const belowMinimum = (result: Scored): string[] => under(result, false);

/** What is only reported: each step's timed categories under their minimum. */
export const timedBelowMinimum = (result: Scored): string[] => under(result, true);

/** Each step's category scores out of 100, by step name. */
export const scoresOf = (result: Scored): Map<string, Record<string, number>> =>
  new Map(
    result.steps.map(({ name, lhr }) => [
      name,
      Object.fromEntries(
        Object.values(lhr.categories).map(({ id, score }) => [id, (score ?? 0) * 100]),
      ),
    ]),
  );
