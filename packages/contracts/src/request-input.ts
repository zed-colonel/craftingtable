import type { z } from 'zod';

type ReadonlyDeep<T> = T extends readonly (infer U)[]
  ? readonly ReadonlyDeep<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
    : T;

/**
 * What a command's sender may pass for a body the daemon parses with `S` (R-H5): the schema's
 * input, read-only throughout so a sender may pass what it holds.
 */
export type RequestInput<S extends z.ZodType> = ReadonlyDeep<z.input<S>>;
