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
 */
export class FileWrites {
  private readonly pending = new Set<Promise<void>>();
  private readonly made = new Set<string>();
  private failure: unknown;

  constructor(private readonly limit = 8) {}

  async write(
    path: string,
    content: string | Uint8Array,
    options: { readonly mode: number; readonly flag?: string; readonly directoryMode?: number },
  ): Promise<void> {
    while (this.pending.size >= this.limit) await Promise.race(this.pending);
    if (this.failure !== undefined) throw this.failure;
    const directory = dirname(path);
    const write = (async () => {
      if (!this.made.has(directory)) {
        await mkdir(directory, { recursive: true, mode: options.directoryMode ?? 0o700 });
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
    await Promise.all(this.pending);
    if (this.failure !== undefined) throw this.failure;
  }
}
