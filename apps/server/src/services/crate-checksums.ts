import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * What the daemon knows of published crates (operator decisions 2026-09-29, R-G13 review). A
 * check's Cargo home is a local registry the daemon builds from this: the published index
 * entries of the crates the checked tree locks, and only downloaded crates whose SHA-256 matches
 * them. Agents write the shared download cache and index, Cargo trusts what it finds in its
 * home, and a lock the agent commits could name any checksum.
 */
export interface CrateChecksumAuthority {
  /** The published SHA-256 of a crate version, or undefined when it cannot be learned now. */
  checksum(source: string, name: string, version: string): Promise<string | undefined>;
  /** The crate's published index file (one JSON line per version), as the registry serves it. */
  indexFile(source: string, name: string): Promise<string | undefined>;
}

/** The lock sources that name crates.io, git-index and sparse. */
const CRATES_IO = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A crate's file in the registry's index, by Cargo's layout. */
export function sparseIndexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/**
 * Reads crates.io's own index over HTTPS, and keeps what it learns in a daemon-owned directory:
 * each crate's index file, and the checksum of every published version, which never changes.
 * Other registries are not trusted. An index that cannot be reached leaves the crate unverified,
 * so the check fails closed, and is not asked again about that crate for a while.
 */
export class CratesIoChecksums implements CrateChecksumAuthority {
  private readonly known = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failed = new Map<string, number>();

  constructor(
    /** A directory under the data directory, outside every writable root of a run. */
    private readonly directory: string,
    private readonly fetchIndex: (url: string, signal: AbortSignal) => Promise<Response> = (
      url,
      signal,
    ) => fetch(url, { signal, redirect: 'error' }),
    private readonly indexUrl = 'https://index.crates.io/',
    private readonly timeoutMs = 15_000,
    private readonly retryAfterMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async checksum(source: string, name: string, version: string): Promise<string | undefined> {
    if (!CRATES_IO.has(source) || !NAME.test(name)) return undefined;
    const key = `${name.toLowerCase()}@${version}`;
    // What was learned before is on disk, one file per crate.
    if (!this.known.has(key)) this.remember(name, this.readIndex(name));
    if (!this.known.has(key)) await this.learn(name);
    return this.known.get(key);
  }

  async indexFile(source: string, name: string): Promise<string | undefined> {
    if (!CRATES_IO.has(source) || !NAME.test(name)) return undefined;
    const saved = this.readIndex(name);
    if (saved !== undefined) return saved;
    await this.learn(name);
    return this.readIndex(name);
  }

  private readIndex(name: string): string | undefined {
    try {
      return readFileSync(this.indexPath(name), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** The checksums of a crate's validated index lines. */
  private remember(name: string, index: string | undefined): string[] {
    const n = name.toLowerCase();
    const lines: string[] = [];
    for (const line of (index ?? '').split('\n')) {
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
        lines.push(line);
      }
    }
    return lines;
  }

  private indexPath(name: string): string {
    return join(this.directory, 'index', sparseIndexPath(name));
  }

  /** Learns every published version of a crate at once, one request at a time per crate. */
  private learn(name: string): Promise<void> {
    const n = name.toLowerCase();
    const running = this.pending.get(n);
    if (running) return running;
    const failedAt = this.failed.get(n);
    if (failedAt !== undefined && this.now() - failedAt < this.retryAfterMs)
      return Promise.resolve();
    const learning = (async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.timeoutMs);
      let learned = false;
      try {
        const response = await this.fetchIndex(
          `${this.indexUrl}${sparseIndexPath(n)}`,
          abort.signal,
        );
        if (!response.ok || !response.body) return;
        // At most 64 MiB, read as it arrives.
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 64 * 1024 * 1024) {
            await reader.cancel();
            return;
          }
          chunks.push(value);
        }
        const lines = this.remember(n, Buffer.concat(chunks).toString('utf8'));
        if (!lines.length) return;
        learned = true;
        this.save(n, `${lines.join('\n')}\n`);
      } catch {
        // Unreachable: the crate stays unverified.
      } finally {
        clearTimeout(timer);
        this.pending.delete(n);
        if (learned) this.failed.delete(n);
        else {
          // Bounded: the oldest failures are forgotten first.
          if (this.failed.size >= 10_000) this.failed.delete(this.failed.keys().next().value!);
          this.failed.set(n, this.now());
        }
      }
    })();
    this.pending.set(n, learning);
    return learning;
  }

  /** One file per crate, written once per lookup: never a rewrite of everything learned. */
  private save(name: string, index: string): void {
    try {
      const path = this.indexPath(name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const next = `${path}.${process.pid}.tmp`;
      writeFileSync(next, index, { mode: 0o600 });
      renameSync(next, path);
    } catch {
      // Kept in memory; learned again after a restart.
    }
  }
}
