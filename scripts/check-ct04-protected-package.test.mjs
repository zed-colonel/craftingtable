import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CT04A2A_PROCESS_FILES,
  CT04A2A_PROOF_FILES,
  ct04a2aTestTitleIds,
  verifyCt04A2aProofAnchors,
  verifyCt04ProtectedPackage,
} from './check-ct04-protected-package.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const protectedDirectory = join(repositoryRoot, 'protected');

function scratchProtectedPackage() {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-protected-'));
  const scratch = join(root, 'protected');
  cpSync(protectedDirectory, scratch, { recursive: true });
  return { root, scratch };
}

function scratchProofPackage() {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-proof-'));
  const paths = [
    ...CT04A2A_PROCESS_FILES,
    ...CT04A2A_PROOF_FILES,
    'work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml',
  ];
  for (const relativePath of paths) {
    const destination = join(root, relativePath);
    mkdirSync(join(destination, '..'), { recursive: true });
    cpSync(join(repositoryRoot, relativePath), destination);
  }
  return root;
}

describe('CT-04 protected-package verifier', () => {
  it('accepts the literal operator-owned package (A2-PROC-004)', () => {
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

describe('CT-04A2a proof-anchor verifier', () => {
  it('expands range and slash title forms', () => {
    expect(
      ct04a2aTestTitleIds([
        "it('range (A2A-REP-001..003)', () => {})",
        "it('slash (A2A-RET-003/006)', () => {})",
      ]),
    ).toEqual(new Set(['A2A-REP-001', 'A2A-REP-002', 'A2A-REP-003', 'A2A-RET-003', 'A2A-RET-006']));
  });

  it('finds every protected and review-added proof in the accepted process lineage (A2-PROC-001..003 A2-SCOPE-001)', () => {
    expect(verifyCt04A2aProofAnchors(repositoryRoot)).toEqual({ ok: true, errors: [] });
  });

  it('fails when one required test-title anchor is removed', () => {
    const root = scratchProofPackage();
    try {
      const path = join(root, 'packages/storage/src/repository-transitions.test.ts');
      writeFileSync(path, readFileSync(path, 'utf8').replace('A2A-REP-016', 'REMOVED-REP-016'));
      expect(verifyCt04A2aProofAnchors(root).errors).toContain(
        'A2A-REP-016 has no test-title anchor',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
