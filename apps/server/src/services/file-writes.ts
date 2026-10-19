import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A launch's many file writes off the event loop (R-B5): an exported upstream tree, a historical
 * baseline, a plan's documents. Each write is the file system's asynchronous call, a few at once,
 * so the daemon goes on answering requests and enforcing deadlines between them, where a loop of
 * `writeFileSync` held it for the whole tree.
 *
 * `write` returns once the write has a slot; `settled` waits for every write and throws the
 * first failure, so a caller that reads its files back, or records them, does so after `settled`.
 * No error leaves while a write is in flight (increment 6 review MEDIUM-1): a refused launch
 * removes what it made, and a late write would race that removal or make a directory again.
 * Callers use `writingFiles`, which also drains them when their own loop throws.
 */
export class FileWrites {
  private readonly pending = new Set<Promise<void>>();
  private readonly made = new Set<string>();
  private failure: unknown;

  constructor(private readonly limit = 8) {}

  async write(
    path: string,
    content: string | Uint8Array,
    options: { readonly mode: number; readonly flag?: string },
  ): Promise<void> {
    while (this.pending.size >= this.limit) await Promise.race(this.pending);
    if (this.failure !== undefined) {
      await this.drained();
      throw this.failure;
    }
    const directory = dirname(path);
    const write = (async () => {
      if (!this.made.has(directory)) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        this.made.add(directory);
      }
      await writeFile(path, content, {
        mode: options.mode,
        ...(options.flag === undefined ? {} : { flag: options.flag }),
      });
    })().catch((error: unknown) => {
      this.failure ??= error;
    });
    this.pending.add(write);
    void write.finally(() => this.pending.delete(write));
  }

  async settled(): Promise<void> {
    await this.drained();
    if (this.failure !== undefined) throw this.failure;
  }

  /** Every write in flight has ended, whatever its outcome (each one's failure is kept). */
  async drained(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }
}

/**
 * `body` with a set of writes, settled before its answer is returned; if `body` or a write throws,
 * every write in flight has ended before the error goes on.
 */
export async function writingFiles<T>(body: (writes: FileWrites) => Promise<T>): Promise<T> {
  const writes = new FileWrites();
  try {
    const answer = await body(writes);
    await writes.settled();
    return answer;
  } catch (error) {
    await writes.drained();
    throw error;
  }
}
