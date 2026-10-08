import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OutsideSourceKind } from '@craftingtable/domain';
import { truncateUtf8 } from './bounded.js';
import type { AgentLaunchRequest } from './index.js';

export type { OutsideSourceKind } from '@craftingtable/domain';

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

/** The Cargo home the daemon named for the run, else Cargo's default; an empty value is unset. */
export function launchCargoHome(request: Pick<AgentLaunchRequest, 'environment'>): string {
  return request.environment?.CARGO_HOME || join(homedir(), '.cargo');
}

/**
 * The outside sources a launch's sandboxed commands may reach (R-G14): those it names, else the
 * `cargo` source in the run's Cargo home, the one source every run had before R-G14, so that
 * `cargo fetch` can download dependencies before the daemon's offline builds. Each adapter
 * decides which postures are sandboxed; an unsandboxed or read-only run gets none.
 */
export function launchOutsideSources(
  request: Pick<AgentLaunchRequest, 'outsideSources' | 'environment'>,
): readonly OutsideSource[] {
  return request.outsideSources ?? [cargoOutsideSource(launchCargoHome(request))];
}

/** Every source's exact hosts, once each. */
export function outsideSourceHosts(sources: readonly OutsideSource[]): string[] {
  return [...new Set(sources.flatMap((source) => source.hosts))];
}

/**
 * Creates the outside sources' caches a sandbox lets a fetch write (R-G14), which it can make
 * writable only if they exist. Only inside an existing directory (for `cargo`, an existing
 * Cargo home), so a host without Rust gets none, and never at the cost of the launch: a cache
 * that cannot be created leaves fetches failing, nothing else.
 */
export function prepareSourceCaches(directories: readonly string[]): void {
  for (const directory of directories) {
    if (!existsSync(dirname(directory))) continue;
    try {
      mkdirSync(directory);
    } catch {
      // Already there, or not ours to create.
    }
  }
}

/**
 * What a launch's commands may reach, for the run's journal (R-G14): the sources with their
 * hosts and caches when the run is sandboxed (every posture but unrestricted, and not read-only,
 * as both adapters apply them), else why none apply. Bounded as a notice.
 */
export function outsideSourcesNote(
  request: Pick<
    AgentLaunchRequest,
    'outsideSources' | 'environment' | 'permissionMode' | 'readOnly'
  >,
): string {
  if (request.readOnly) return 'Outside sources: none, as for every read-only run.';
  if (request.permissionMode === 'unrestricted')
    return 'Outside sources: not applied. An unrestricted run has no sandbox; its commands reach any host, with your authority.';
  const sources = launchOutsideSources(request);
  if (sources.length === 0)
    return 'Outside sources for sandboxed commands: none. Commands reach no network.';
  const listed = sources
    .map(
      (source) =>
        `${source.kind} (hosts ${source.hosts.join(', ')}; writes ${source.caches.join(', ')})`,
    )
    .join('; ');
  const tail = ' Commands reach no other host.';
  const head = 'Outside sources for sandboxed commands: ';
  return `${head}${truncateUtf8(`${listed}.`, 4000 - head.length - tail.length).text}${tail}`;
}
