import type { z } from 'zod';

/**
 * Compile-time equivalence between a contract schema and the type it describes (R-H3,
 * DATA-10). Domain types stay the source of truth; a schema that drifts from its domain
 * type fails `pnpm typecheck` with a `Drift` naming the differing fields.
 */

/** Deep structural view: readonly dropped, branded identifiers kept. */
export type Plain<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? Plain<U>[]
      : { -readonly [K in keyof T]: Plain<T[K]> };

type Identical<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

export type Equivalent<A, B> = Identical<Plain<A>, Plain<B>>;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
type KindOf<T> = T extends { kind: infer K extends string } ? K : never;
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;
type ObjectDrift<A, B> = Expand<{
  onlyInSchema: Exclude<keyof A, keyof B>;
  onlyInType: Exclude<keyof B, keyof A>;
  differ: {
    [K in keyof A & keyof B as Identical<A[K], B[K]> extends true ? never : K]: DriftOf<A[K], B[K]>;
  };
}>;
type DriftOf<A, B> =
  Identical<A, B> extends true
    ? never
    : [A] extends [readonly (infer X)[]]
      ? [B] extends [readonly (infer Y)[]]
        ? { items: DriftOf<X, Y> }
        : { schema: A; type: B }
      : [A] extends [object]
        ? [B] extends [object]
          ? true extends IsUnion<A>
            ? [KindOf<A>] extends [never]
              ? { schema: A; type: B }
              : {
                  kinds: Exclude<KindOf<A>, KindOf<B>> | Exclude<KindOf<B>, KindOf<A>>;
                  each: {
                    [K in KindOf<A> as Identical<
                      Extract<A, { kind: K }>,
                      Extract<B, { kind: K }>
                    > extends true
                      ? never
                      : K]: ObjectDrift<Extract<A, { kind: K }>, Extract<B, { kind: K }>>;
                  };
                }
            : ObjectDrift<A, B>
          : { schema: A; type: B }
        : { schema: A; type: B };

/** What differs between a schema's output and a type; shown in the compiler error. */
export type Drift<A, B> = DriftOf<Plain<A>, Plain<B>>;

/** The value a schema accepts, as TypeScript sees it. */
export type SchemaOutput<S extends z.ZodType> = z.output<S>;

/**
 * Accepts `schema` only when its output is equivalent to `T`; otherwise the argument type
 * becomes a `Drift` report and the call fails to compile.
 */
export function equivalentSchema<T>() {
  return <S extends z.ZodType>(
    schema: S &
      (Equivalent<z.output<S>, T> extends true
        ? unknown
        : { readonly drift: Drift<z.output<S>, T> }),
  ): S => schema;
}
