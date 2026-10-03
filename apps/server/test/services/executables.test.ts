import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveExecutable } from '../../src/services/executables.js';

it('finds Codex on PATH and respects an explicit override', () => {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-executable-'));
  try {
    const executable = join(directory, 'codex');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    expect(resolveExecutable('codex', undefined, { PATH: directory })).toBe(executable);
    expect(resolveExecutable('codex', '/missing/codex', { PATH: directory })).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
