/**
 * A value the code knows is present, checked where it is read (R-B7; the operator's amendment
 * of 2026-09-24, after R-I6): an absent one throws an error that names it, where a non-null
 * assertion would surface later as an anonymous `TypeError` far from its cause. It is a plain
 * `Error`, never a request's refusal, so a controller pass stops on it as on any unexpected error
 * (`controller-error`) and a command answers 500, as before.
 */
export class InvariantError extends Error {
  /** What was absent, as `required` was told: the controller's step history records it (R-B5). */
  readonly what: string;
  constructor(what: string) {
    super(`Invariant failed: ${what}`);
    this.name = 'InvariantError';
    this.what = what;
  }
}

/** `value`, or an `InvariantError` naming `what` when it is absent (`undefined` or `null`). */
export function required<T>(value: T, what: string): NonNullable<T> {
  if (value === undefined || value === null) throw new InvariantError(what);
  return value as NonNullable<T>;
}
