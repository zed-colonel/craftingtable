import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Where the daemon learns which bytes a crate version is (operator decision 2026-09-29, R-G13
 * review). A check's private Cargo home holds only downloaded crates whose SHA-256 matches this
 * authority: agents write the shared download cache and index, Cargo trusts a cached `.crate`
 * without checking it again, and a lock the agent commits could name any checksum.
 */
export interface CrateChecksumAuthority {
  /** The published SHA-256 of a crate version, or undefined when it cannot be learned now. */
  checksum(source: string, name: string, version: string): Promise<string | undefined>;
}

/** The lock sources that name crates.io, git-index and sparse. */
const CRATES_IO = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);

/** A crate's file in the registry's sparse index, by Cargo's layout. */
export function sparseIndexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/**
 * Reads checksums from crates.io's own index over HTTPS, and keeps each one in a daemon-owned
 * file for good: a published version never changes. Other registries are not trusted, and an
 * index that cannot be reached leaves the crate unverified, so the check fails closed.
 */
export class CratesIoChecksums implements CrateChecksumAuthority {
  private readonly known = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    /** A file under the data directory, outside every writable root of a run. */
    private readonly cacheFile: string,
    private readonly fetchIndex: (url: string, signal: AbortSignal) => Promise<Response> = (
      url,
      signal,
    ) => fetch(url, { signal, redirect: 'error' }),
    private readonly indexUrl = 'https://index.crates.io/',
    private readonly timeoutMs = 15_000,
  ) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(saved))
        if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) this.known.set(key, value);
    } catch {
      // No checksum learned yet.
    }
  }

  async checksum(source: string, name: string, version: string): Promise<string | undefined> {
    if (!CRATES_IO.has(source) || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) return undefined;
    const key = `${name.toLowerCase()}@${version}`;
    if (!this.known.has(key)) await this.learn(name);
    return this.known.get(key);
  }

  /** Learns every published version of a crate at once, one request at a time per crate. */
  private learn(name: string): Promise<void> {
    const n = name.toLowerCase();
    const running = this.pending.get(n);
    if (running) return running;
    const learning = (async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.timeoutMs);
      try {
        const response = await this.fetchIndex(
          `${this.indexUrl}${sparseIndexPath(n)}`,
          abort.signal,
        );
        if (!response.ok) return;
        const text = await response.text();
        if (text.length > 64 * 1024 * 1024) return;
        let learned = false;
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let entry: { name?: unknown; vers?: unknown; cksum?: unknown };
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            typeof entry.name === 'string' &&
            entry.name.toLowerCase() === n &&
            typeof entry.vers === 'string' &&
            typeof entry.cksum === 'string' &&
            /^[a-f0-9]{64}$/.test(entry.cksum)
          ) {
            this.known.set(`${n}@${entry.vers}`, entry.cksum);
            learned = true;
          }
        }
        if (learned) this.save();
      } catch {
        // Unreachable: the crate stays unverified.
      } finally {
        clearTimeout(timer);
        this.pending.delete(n);
      }
    })();
    this.pending.set(n, learning);
    return learning;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      const next = `${this.cacheFile}.${process.pid}.tmp`;
      writeFileSync(next, JSON.stringify(Object.fromEntries(this.known)), { mode: 0o600 });
      renameSync(next, this.cacheFile);
    } catch {
      // Kept in memory; learned again after a restart.
    }
  }
}
