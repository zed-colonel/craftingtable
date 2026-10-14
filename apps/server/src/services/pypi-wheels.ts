import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  type Stats,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isWheelFilename,
  PYPI_FILES,
  type PythonWheelSource,
  type WheelRequest,
} from '@craftingtable/agents';

/** A normalized-enough project name and version for PyPI's JSON API path; nothing else. */
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
/** A version with a letter or digit in it: `.` and `..` would collapse PyPI's URL. */
const VERSION = /^(?=.*[A-Za-z0-9])[A-Za-z0-9.+!_-]{1,64}$/;
const FILENAME = /^[A-Za-z0-9_.!+-]{1,255}\.whl$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** The most of PyPI's JSON answer for one release the daemon reads. */
const JSON_MAX_BYTES = 16 * 1024 * 1024;

export interface PypiWheelStoreOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The largest wheel the daemon fetches: 512 MiB by default. */
  readonly maxFileBytes?: number;
  /** The most the store keeps: 20 GiB by default; the least recently used go first. */
  readonly budgetBytes?: number;
  /** Requests to PyPI per window, JSON and files alike: 600 per ten minutes by default. */
  readonly requestsPerWindow?: number;
  readonly windowMs?: number;
  readonly jsonTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  readonly now?: () => number;
}

class WheelProblem extends Error {}

/** A request that ran past its time limit: reported as such even though its signal aborted. */
class WheelTimeout extends WheelProblem {}

type WheelResult = { path: string } | { problem: string };

/** One download every check that wants the file shares, stopped once none still waits. */
interface SharedFetch {
  readonly result: Promise<WheelResult>;
  readonly controller: AbortController;
  waiting: number;
}

/**
 * The daemon's verified wheel store (R-G17 decision 8, ADR-074): the wheels Python checks use,
 * fetched by the daemon itself from PyPI's JSON API and files.pythonhosted.org only, with
 * redirects refused, a per-file size cap, a rate window and a store budget. A file is kept,
 * under its SHA-256, only when its bytes match both PyPI's published digest and the lock's hash:
 * the lock selects, PyPI vouches. The store is the daemon's own (`<data>/pypi-wheels`): no agent
 * or check unit writes it, and a check copies what it needs and hashes it again.
 */
export class PypiWheelStore implements PythonWheelSource {
  private readonly pending = new Map<string, SharedFetch>();
  private window = { start: 0, count: 0 };
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  private readonly maxFileBytes: number;
  private readonly budgetBytes: number;
  private readonly requestsPerWindow: number;
  private readonly windowMs: number;
  private readonly jsonTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    /** A directory under the data directory, outside every root agents or checks write. */
    private readonly root: string,
    options: PypiWheelStoreOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.maxFileBytes = options.maxFileBytes ?? 512 * 1024 * 1024;
    this.budgetBytes = options.budgetBytes ?? 20 * 1024 ** 3;
    this.requestsPerWindow = options.requestsPerWindow ?? 600;
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.jsonTimeoutMs = options.jsonTimeoutMs ?? 30_000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    // What a stopped daemon left half-written is nobody's: the store is this daemon's alone.
    rmSync(join(root, 'tmp'), { recursive: true, force: true });
  }

  async wheel(
    request: WheelRequest,
    signal: AbortSignal,
  ): Promise<{ path: string } | { problem: string }> {
    if (
      !NAME.test(request.name) ||
      !VERSION.test(request.version) ||
      !FILENAME.test(request.filename) ||
      !isWheelFilename(request.filename) ||
      !SHA256.test(request.sha256)
    )
      return {
        problem: `${JSON.stringify(request.filename).slice(0, 300)} is not a wheel request the daemon fetches`,
      };
    const directory = join(this.root, 'files', request.sha256);
    const stored = join(directory, request.filename);
    if (await this.storedFile(stored, request.sha256)) return { path: stored };
    const key = `${request.sha256}/${request.filename}`;
    let shared = this.pending.get(key);
    if (!shared) {
      const controller = new AbortController();
      const created: SharedFetch = {
        controller,
        waiting: 0,
        result: this.fetchWheel(request, stored, controller.signal).finally(() => {
          if (this.pending.get(key) === created) this.pending.delete(key);
        }),
      };
      shared = created;
      this.pending.set(key, shared);
    }
    // Each check waits on its own terms: its cancel releases it at once, and the download goes
    // on for the others; it stops only when no check still waits for it.
    shared.waiting++;
    try {
      return await new Promise<WheelResult>((resolve) => {
        const cancelled = () => resolve({ problem: `fetching ${request.filename} was cancelled` });
        if (signal.aborted) return cancelled();
        signal.addEventListener('abort', cancelled, { once: true });
        void shared.result.then((result) => {
          signal.removeEventListener('abort', cancelled);
          resolve(result);
        });
      });
    } finally {
      shared.waiting--;
      if (shared.waiting === 0 && this.pending.get(key) === shared) {
        this.pending.delete(key);
        shared.controller.abort();
      }
    }
  }

  /**
   * Whether the store holds the file: a regular file, no link, whose bytes still hash to its
   * digest (a crash can leave a truncated one). Anything else in its place is removed, so it is
   * fetched again. Marks it used.
   */
  private async storedFile(path: string, sha256: string): Promise<boolean> {
    let found: Stats | undefined;
    try {
      found = lstatSync(path);
      if (!found.isFile()) throw new WheelProblem('not a file');
      if ((await fileDigest(path)) !== sha256) throw new WheelProblem('not its digest');
      const at = this.now() / 1000;
      utimesSync(path, at, at);
      return true;
    } catch {
      // Removed only if it is still the file that was found: another check may have fetched a
      // good copy into its place meanwhile (re-check N-3).
      try {
        const now = lstatSync(path);
        if (found && now.ino === found.ino && now.dev === found.dev)
          rmSync(path, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      return false;
    }
  }

  /** Counts one request to PyPI against the window, or refuses it. */
  private allow(): void {
    if (this.now() - this.window.start >= this.windowMs)
      this.window = { start: this.now(), count: 0 };
    if (this.window.count >= this.requestsPerWindow)
      throw new WheelProblem(
        `the daemon reached its rate limit of ${this.requestsPerWindow} PyPI requests per ${Math.round(this.windowMs / 60_000)} minutes; run the check again later`,
      );
    this.window.count++;
  }

  private async fetchWheel(
    request: WheelRequest,
    stored: string,
    signal: AbortSignal,
  ): Promise<{ path: string } | { problem: string }> {
    const temporary = join(this.root, 'tmp', randomUUID());
    try {
      mkdirSync(join(this.root, 'tmp'), { recursive: true, mode: 0o700 });
      const file = await this.release(request, signal);
      await this.download(file.url, file.size, request.sha256, temporary, signal);
      mkdirSync(join(this.root, 'files', request.sha256), { recursive: true, mode: 0o700 });
      renameSync(temporary, stored);
      this.keepWithinBudget(stored);
      return { path: stored };
    } catch (error) {
      rmSync(temporary, { force: true });
      if (signal.aborted && !(error instanceof WheelTimeout))
        return { problem: `fetching ${request.filename} was cancelled` };
      return {
        problem: `${request.filename} could not be verified: ${
          error instanceof WheelProblem
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error)
        }`,
      };
    }
  }

  /** The release file PyPI publishes under this name, checked against the lock's hash. */
  private async release(
    request: WheelRequest,
    signal: AbortSignal,
  ): Promise<{ url: string; size: number }> {
    this.allow();
    const url = `https://pypi.org/pypi/${encodeURIComponent(request.name)}/${encodeURIComponent(request.version)}/json`;
    const timeout = AbortSignal.timeout(this.jsonTimeoutMs);
    const response = await this.fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.any([signal, timeout]),
    }).catch((error: unknown) => {
      if (timeout.aborted)
        throw new WheelTimeout(`timed out asking PyPI after ${this.jsonTimeoutMs} ms`);
      throw error;
    });
    if (!response.ok)
      throw new WheelProblem(
        `PyPI answered ${response.status} for ${request.name} ${request.version}`,
      );
    const text = await boundedText(
      response,
      JSON_MAX_BYTES,
      AbortSignal.any([signal, timeout]),
    ).catch((error: unknown) => {
      if (timeout.aborted)
        throw new WheelTimeout(`timed out reading PyPI's answer after ${this.jsonTimeoutMs} ms`);
      throw error;
    });
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      throw new WheelProblem('PyPI answered with something other than JSON');
    }
    const files = (answer as { urls?: unknown }).urls;
    const entry = (Array.isArray(files) ? files : []).find(
      (file: { filename?: unknown; packagetype?: unknown }) =>
        file?.filename === request.filename && file?.packagetype === 'bdist_wheel',
    ) as { url?: unknown; size?: unknown; digests?: { sha256?: unknown } } | undefined;
    if (!entry)
      throw new WheelProblem(`it is not on PyPI as a wheel of ${request.name} ${request.version}`);
    if (entry.digests?.sha256 !== request.sha256)
      throw new WheelProblem(
        `PyPI's digest for it is not the lock's hash, so the lock does not name PyPI's file`,
      );
    let location: URL;
    try {
      location = new URL(String(entry.url));
    } catch {
      throw new WheelProblem('PyPI names no valid location for it');
    }
    if (location.origin !== new URL(PYPI_FILES).origin || location.username || location.password)
      throw new WheelProblem(
        `PyPI names it at ${location.origin}, not https://files.pythonhosted.org`,
      );
    const size = entry.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0)
      throw new WheelProblem('PyPI gives it no size');
    if (size > this.maxFileBytes)
      throw new WheelProblem(`it is larger than the ${this.maxFileBytes}-byte limit for one wheel`);
    return { url: location.href, size };
  }

  /** Streams the file to `temporary`, hashing it; refuses more bytes than PyPI declared. */
  private async download(
    url: string,
    size: number,
    sha256: string,
    temporary: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.allow();
    const timeout = AbortSignal.timeout(this.downloadTimeoutMs);
    const stop = AbortSignal.any([signal, timeout]);
    const ended = () =>
      timeout.aborted
        ? new WheelTimeout(`timed out after ${this.downloadTimeoutMs} ms`)
        : new WheelProblem('cancelled');
    const response = await this.fetchImpl(url, { redirect: 'error', signal: stop }).catch(
      (error: unknown) => {
        if (timeout.aborted) throw new WheelTimeout(`timed out after ${this.downloadTimeoutMs} ms`);
        throw error;
      },
    );
    if (!response.ok || !response.body)
      throw new WheelProblem(`files.pythonhosted.org answered ${response.status}`);
    const hash = createHash('sha256');
    const handle = await open(temporary, 'wx', 0o600);
    let received = 0;
    let end: () => void = () => undefined;
    try {
      const reader = response.body.getReader();
      // A cancel or the time limit ends a read that hangs, as the request's own abort may not.
      const aborted = new Promise<never>((_, reject) => {
        end = () => {
          // Rejected first: cancelling settles a pending read at once, as if the file ended.
          reject(ended());
          void reader.cancel().catch(() => undefined);
        };
        if (stop.aborted) end();
        else stop.addEventListener('abort', end, { once: true });
      });
      aborted.catch(() => undefined);
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        received += value.byteLength;
        // `size` is within the per-file limit already, so this holds the stream to both.
        if (received > size) {
          void reader.cancel().catch(() => undefined);
          throw new WheelProblem(
            `files.pythonhosted.org sent more bytes than PyPI declared (${size})`,
          );
        }
        hash.update(value);
        await handle.write(value);
      }
      // On disk before the rename makes it the stored file.
      await handle.sync();
    } finally {
      // Nothing of this download outlives it (re-check N-4).
      stop.removeEventListener('abort', end);
      await handle.close();
    }
    if (stop.aborted) throw ended();
    if (received !== size || hash.digest('hex') !== sha256)
      throw new WheelProblem(`its bytes do not match PyPI's digest and the lock's hash`);
  }

  /** Removes the least recently used wheels until the store is within its budget. */
  private keepWithinBudget(keep: string): void {
    const files = join(this.root, 'files');
    const entries: { directory: string; path: string; bytes: number; used: number }[] = [];
    for (const digest of readdirSync(files)) {
      const directory = join(files, digest);
      try {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          const status = statSync(path);
          entries.push({ directory, path, bytes: status.size, used: status.mtimeMs });
        }
      } catch {
        // Not a directory of the store's: left alone.
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries.sort((a, b) => a.used - b.used)) {
      if (total <= this.budgetBytes) break;
      if (entry.path === keep) continue;
      rmSync(entry.directory, { recursive: true, force: true });
      total -= entry.bytes;
    }
  }
}

/** A file's SHA-256, read as a stream. */
function fileDigest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** A response's text, refused past `limit` bytes as it arrives; `stop` ends a hanging read. */
async function boundedText(response: Response, limit: number, stop: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  let end: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    end = () => {
      reject(new WheelProblem('stopped'));
      void reader.cancel().catch(() => undefined);
    };
    if (stop.aborted) end();
    else stop.addEventListener('abort', end, { once: true });
  });
  stopped.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        void reader.cancel().catch(() => undefined);
        throw new WheelProblem(`PyPI's answer is larger than ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    // Nothing of this read outlives it (re-check N-4).
    stop.removeEventListener('abort', end);
  }
  return Buffer.concat(chunks).toString('utf8');
}
