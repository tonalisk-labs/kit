// CSP violations a browser engine reports through a defect of its own, which no code of the target's
// causes: a target names each in its adapter, with the defect's report and a day to look again.

/** An engine as Playwright names it (`browserName`). */
type Engine = 'chromium' | 'firefox' | 'webkit';

/** One engine's own violation: the directive and blocked value its `securitypolicyviolation` event
 *  names, and the line the engine writes to the console beside it, which names the policy. */
export interface CspException {
  readonly engine: Engine;
  readonly directive: string;
  readonly blocked: string;
  readonly console: string;
  /** Why it is no fault of the target. */
  readonly reason: string;
  /** The defect's report: its link once filed, else the draft's path. */
  readonly bug: string;
  /** The day it is looked at again, as `YYYY-MM-DD`, within half a year; past it, every test fails
   *  naming it. */
  readonly reviewBy: string;
}

/** How the invariants put a violation on the console: these, with its directive and blocked value
 *  between and after. The page's listener writes them; `excepted` reads them back. */
export const VIOLATION_WORDS = { before: 'CSP violation: ', between: ' blocked ' } as const;

const violationLine = ({ directive, blocked }: CspException): string =>
  `${VIOLATION_WORDS.before}${directive}${VIOLATION_WORDS.between}${blocked}`;

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** How each engine names the policy in its console lines: WebKit and Chromium spaced, Firefox
 *  hyphenated. A line that names none is no CSP line, which an exception can't let pass. */
const CSP_WORDING = /Content[ -]Security[ -]Policy/u;

/** The furthest a day to look again may be, so that no exception is parked for good. */
const HALF_YEAR_MS = 183 * 24 * 60 * 60 * 1000;

/** Why an exception can't stand on `today` (`YYYY-MM-DD`), or undefined when it can. */
const faultOf = (exception: CspException, today: string): string | undefined => {
  const { console: line, reviewBy } = exception;
  const due = Date.parse(reviewBy);
  if (!CSP_WORDING.test(line)) {
    return 'its console line names no Content Security Policy';
  }
  if (!DAY.test(reviewBy) || Number.isNaN(due)) {
    return 'it has no day, as YYYY-MM-DD, to be looked at again';
  }
  if (reviewBy < today) {
    return `it was to be looked at again by ${reviewBy}`;
  }
  return due - Date.parse(today) > HALF_YEAR_MS
    ? `its day to be looked at again, ${reviewBy}, is more than half a year away`
    : undefined;
};

/** Whether `text`, said on `engine` on `today`, is a violation a standing exception lets pass, or
 *  that engine's own line for it: each matched whole, never in part. */
export const excepted = (
  exceptions: readonly CspException[],
  { engine, today }: { readonly engine: string; readonly today: string },
  text: string,
): boolean =>
  exceptions.some(
    (exception) =>
      exception.engine === engine &&
      faultOf(exception, today) === undefined &&
      (text === violationLine(exception) || text === exception.console),
  );

/** Each exception that can't stand on `today`, as the problem it is: a defect told once is looked at
 *  again within half a year, and only a CSP line is let pass. */
export const exceptionProblems = (exceptions: readonly CspException[], today: string): string[] =>
  exceptions.flatMap((exception) => {
    const fault = faultOf(exception, today);
    return fault === undefined
      ? []
      : [
          `CSP exception refused: ${exception.engine}'s "${violationLine(exception)}": ${fault} (${exception.bug})`,
        ];
  });
