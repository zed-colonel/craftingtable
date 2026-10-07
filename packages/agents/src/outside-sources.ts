import { join } from 'node:path';

/** The kinds of outside source the daemon knows (R-G14): for now only Cargo's registry. */
export type OutsideSourceKind = 'cargo';

/**
 * An outside source a sandboxed agent command may reach (R-G14): exact host names, and the
 * daemon-owned caches a fetch from them writes. The daemon resolves them from the operator's
 * settings; adapters only pass them to their sandbox.
 */
export interface OutsideSource {
  readonly kind: OutsideSourceKind;
  /** Exact lowercase host names: no wildcard, IP address or port. */
  readonly hosts: readonly string[];
  /** Absolute directories a fetch writes; each must already exist to be made writable. */
  readonly caches: readonly string[];
}

/**
 * Each kind's fixed hosts. Cargo's: only what a sparse fetch reads, the index and the downloads.
 * The `crates.io` apex is the write API (publish, yank), which would carry data out (R-G5
 * follow-up review).
 */
export const OUTSIDE_SOURCE_HOSTS: Readonly<Record<OutsideSourceKind, readonly string[]>> = {
  cargo: ['index.crates.io', 'static.crates.io'],
};

/**
 * The `cargo` source in `cargoHome`: its hosts, any extra ones, and Cargo's registry and Git
 * caches, the same two directories the daemon's check units may write, and nothing else of
 * the Cargo home.
 */
export function cargoOutsideSource(
  cargoHome: string,
  extraHosts: readonly string[] = [],
): OutsideSource {
  return {
    kind: 'cargo',
    hosts: [...new Set([...OUTSIDE_SOURCE_HOSTS.cargo, ...extraHosts])],
    caches: [join(cargoHome, 'registry'), join(cargoHome, 'git')],
  };
}
