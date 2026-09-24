import { z } from 'zod';

/** Display names in the retired repository registry's journal events (R-B8). */
const hasNoControls = (value: string): boolean =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });

export const repositoryDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(hasNoControls, { message: 'must not contain C0 or DEL controls' });
