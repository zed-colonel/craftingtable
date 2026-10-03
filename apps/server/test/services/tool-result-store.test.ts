import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AgentRunEventPayload } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  offloadToolResult,
  readToolResult,
  TOOL_RESULTS_DIRECTORY,
} from '../../src/services/tool-result-store.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ct-tool-results-'));
  directories.push(directory);
  return directory;
}

const content = 'x'.repeat(10_000);
const digest = createHash('sha256').update(content, 'utf8').digest('hex');
const payload = { toolUseId: 't1', content, isError: false } as AgentRunEventPayload<'tool-result'>;

function plant(run: string, bytes: Buffer | string): string {
  const directory = join(run, TOOL_RESULTS_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${digest}.txt.gz`);
  writeFileSync(path, bytes);
  return path;
}

describe('tool-result bodies (R-H2)', () => {
  it('stores a large output once and reads it back', () => {
    const run = runDirectory();
    const journaled = offloadToolResult(payload, run);
    expect(journaled.body).toEqual({ digest, bytes: 10_000 });
    expect(Buffer.byteLength(journaled.content, 'utf8')).toBeLessThanOrEqual(4096);
    expect(readToolResult(run, digest)).toBe(content);
  });

  it('replaces a file planted under the digest instead of trusting it', () => {
    const run = runDirectory();
    plant(run, gzipSync('something else'));
    expect(readToolResult(run, digest)).toBeUndefined();
    offloadToolResult(payload, run);
    expect(readToolResult(run, digest)).toBe(content);
  });

  it('reads a non-gzip file, a link or a FIFO as absent without blocking', () => {
    const run = runDirectory();
    const path = plant(run, 'not gzip');
    expect(readToolResult(run, digest)).toBeUndefined();

    rmSync(path);
    const target = join(run, 'elsewhere.gz');
    writeFileSync(target, gzipSync(content));
    symlinkSync(target, path);
    expect(readToolResult(run, digest)).toBeUndefined();

    rmSync(path);
    execFileSync('mkfifo', [path]);
    expect(readToolResult(run, digest)).toBeUndefined();
  });

  it('refuses a body that decompresses beyond the limit', () => {
    const run = runDirectory();
    plant(run, gzipSync(Buffer.alloc(9 * 1024 * 1024)));
    expect(readToolResult(run, digest)).toBeUndefined();
  });
});
