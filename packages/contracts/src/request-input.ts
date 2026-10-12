import type { z } from 'zod';

// Primitives first: a branded id is a string, though its brand makes it an object to the type
// system, and mapping over it would take it apart.
type ReadonlyDeep<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? readonly ReadonlyDeep<U>[]
    : T extends object
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : T;

/**
 * What a command's sender may pass for a body the daemon parses with `S` (R-H5): the schema's
 * input, read-only throughout so a sender may pass what it holds.
 */
export type RequestInput<S extends z.ZodType> = ReadonlyDeep<z.input<S>>;
