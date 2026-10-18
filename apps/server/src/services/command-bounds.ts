/**
 * The bounds the daemon holds operator input to after it joins it (CTRL-14, R-B7): one copy each,
 * which every site asks; each site keeps its own refusal (operator decision 4, 2026-10-17). The
 * contracts bound each request field on the wire; these bound what the daemon composes.
 */

/** The most characters of instructions or guidance the daemon passes a step at once. */
export const INSTRUCTION_LIMIT = 16_000;

/** Whether composed instructions or guidance fit the bound. */
export function withinInstructionLimit(text: string): boolean {
  return text.length <= INSTRUCTION_LIMIT;
}

/** The most remediation rounds or stage attempts an operator adds at once. */
export const EXTRA_ROUNDS_LIMIT = 20;

/**
 * Whether `rounds` may be added at once: a whole number from `min` (1, or 0 where none is a
 * choice) to 20, which keeps the cycle's total (`base` before it) a safe integer.
 */
export function validExtraRounds(
  rounds: number,
  { min, base }: { readonly min: 0 | 1; readonly base: number },
): boolean {
  return (
    Number.isInteger(rounds) &&
    rounds >= min &&
    rounds <= EXTRA_ROUNDS_LIMIT &&
    base + rounds <= Number.MAX_SAFE_INTEGER - EXTRA_ROUNDS_LIMIT
  );
}
