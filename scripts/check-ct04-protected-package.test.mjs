import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyCt04ProtectedPackage } from './check-ct04-protected-package.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const protectedDirectory = join(repositoryRoot, 'protected');

function scratchProtectedPackage() {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-protected-'));
  const scratch = join(root, 'protected');
  cpSync(protectedDirectory, scratch, { recursive: true });
  return { root, scratch };
}

describe('CT-04 protected-package verifier', () => {
  it('accepts the literal operator-owned package', () => {
    expect(verifyCt04ProtectedPackage(protectedDirectory)).toEqual({ ok: true, errors: [] });
  });

  it('rejects an expected-outcome mutation', () => {
    const { root, scratch } = scratchProtectedPackage();
    try {
      const path = join(scratch, 'CT-04-protected-acceptance-spec.yaml');
      const source = readFileSync(path, 'utf8');
      writeFileSync(path, source.replace('expected: rejected', 'expected: accepted'));
      expect(verifyCt04ProtectedPackage(scratch).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an extra protected file', () => {
    const { root, scratch } = scratchProtectedPackage();
    try {
      writeFileSync(join(scratch, 'extra.yaml'), 'unexpected');
      expect(verifyCt04ProtectedPackage(scratch).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
