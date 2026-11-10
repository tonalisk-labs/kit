// A rule's id names a page's rule (Pnn) or a site's (Snn). A warning fails only a --strict run.
type Severity = 'error' | 'warn';

interface Rule {
  readonly id: string;
  readonly severity: Severity;
}

export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  /** The page's address, or the file a site rule read. */
  readonly where: string;
  readonly message: string;
}

export const failing = (id: string): Rule => ({ id, severity: 'error' });
export const warning = (id: string): Rule => ({ id, severity: 'warn' });

export const findings = (rule: Rule, where: string, messages: readonly string[]): Finding[] =>
  messages.map((message) => ({ rule: rule.id, severity: rule.severity, where, message }));
