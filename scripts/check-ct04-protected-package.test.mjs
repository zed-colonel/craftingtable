import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CT04A2A_PROCESS_FILES,
  CT04A2A_PROOF_FILES,
  CT04A2B1_PROCESS_FILES,
  CT04A2B1_PROOF_FILES,
  b1ChangedPathViolations,
  ct04a2b1ProtectedIds,
  ct04a2aTestTitleIds,
  verifyCt04A2aDocumentLineage,
  verifyCt04A2aProofAnchors,
  verifyCt04A2aProcessLineage,
  verifyCt04A2b1DocumentLineage,
  verifyCt04A2b1Inventory,
  verifyCt04A2b1ProofAnchors,
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

  it('finds every behavior proof required to have a test-title anchor (A2-SCOPE-001)', () => {
    expect(verifyCt04A2aProofAnchors(repositoryRoot)).toEqual({ ok: true, errors: [] });
  });

  it('verifies process chronology through artifact hashes and actual Git ancestry', () => {
    expect(verifyCt04A2aProcessLineage(repositoryRoot)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a design review that no longer pins the live proposed plan', () => {
    const root = scratchProofPackage();
    try {
      const path = join(root, 'review-findings/CT-04/CT-04A2a-design-review.md');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '67c6444ca23ba8d19902ad01a05ef4d31a5c990e4d8d02b1049cde458fcd2c81',
          '0'.repeat(64),
        ),
      );
      expect(verifyCt04A2aDocumentLineage(root).errors).toContain(
        'A2-PROC-001 design review does not pin the live proposed-plan SHA-256',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('CT-04A2b1 proof and inventory verifier', () => {
  it('B1-SCOPE-002/B1-SCOPE-003 finds the exact protected B1 case set', () => {
    const source = readFileSync(
      join(repositoryRoot, 'work-items/CT-04/CT-04A2b-protected-acceptance-supplement.yaml'),
      'utf8',
    );
    expect(ct04a2b1ProtectedIds(source)).toHaveLength(66);
    expect(verifyCt04A2b1ProofAnchors(repositoryRoot)).toEqual({ ok: true, errors: [] });
  });

  it('B1-PROC-001/B1-PROC-002 verifies the review hash chain and reconciliation appendix', () => {
    expect(CT04A2B1_PROCESS_FILES).toHaveLength(4);
    expect(CT04A2B1_PROOF_FILES.length).toBeGreaterThan(0);
    expect(verifyCt04A2b1DocumentLineage(repositoryRoot)).toEqual({ ok: true, errors: [] });
  });

  it('B1-SCOPE-005 rejects manifests, routes, services, configuration, and A2a state paths', () => {
    expect(
      b1ChangedPathViolations([
        'package.json',
        'pnpm-lock.yaml',
        'apps/server/src/routes/repository.ts',
        'apps/server/src/services/repository-service.ts',
        'packages/storage/src/repositories/repository-registry/repositories.ts',
      ]),
    ).toEqual([
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: package.json',
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: pnpm-lock.yaml',
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: apps/server/src/routes/repository.ts',
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: apps/server/src/services/repository-service.ts',
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: packages/storage/src/repositories/repository-registry/repositories.ts',
    ]);
    expect(verifyCt04A2b1Inventory(repositoryRoot)).toEqual({ ok: true, errors: [] });
  });

  it('B1-R-02 excludes the complete root CT-04A scratch class through Git inventory', () => {
    const gitScratch = mkdtempSync(join(repositoryRoot, '.ct04a-git-test-'));
    const hostileHomeScratch = mkdtempSync(join(repositoryRoot, '.ct04a-hostile-home-'));
    try {
      writeFileSync(join(gitScratch, 'counting-git'), 'scratch');
      mkdirSync(join(hostileHomeScratch, 'template', 'hooks'), { recursive: true });
      writeFileSync(join(hostileHomeScratch, 'template', 'hooks', 'hostile-hook'), 'scratch');
      writeFileSync(join(hostileHomeScratch, 'hostile-gitconfig'), 'scratch');

      expect(verifyCt04A2b1Inventory(repositoryRoot)).toEqual({ ok: true, errors: [] });
    } finally {
      rmSync(gitScratch, { recursive: true, force: true });
      rmSync(hostileHomeScratch, { recursive: true, force: true });
    }

    expect(
      b1ChangedPathViolations([
        '.ct04a-git-test-source.ts',
        '.ct04a-git-testX/evil.ts',
        'nested/.ct04a-git-test-f9NlNr/counting-git',
      ]),
    ).toEqual([
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: .ct04a-git-test-source.ts',
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: .ct04a-git-testX/evil.ts',
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: nested/.ct04a-git-test-f9NlNr/counting-git',
    ]);
  });

  it('B1-A-06 admits required B1 implementation and remediation review artifacts', () => {
    expect(
      b1ChangedPathViolations([
        'review-findings/CT-04/CT-04A2b1-initial-review.md',
        'review-findings/CT-04/CT-04A2b1-remediation-review.md',
        'review-findings/CT-04/CT-04A2b1-remediation-2-review.md',
      ]),
    ).toEqual([]);
    expect(b1ChangedPathViolations(['review-findings/CT-04/CT-04A2b2-initial-review.md'])).toEqual([
      'B1-SCOPE-005 changed path is outside the accepted B1 tree: review-findings/CT-04/CT-04A2b2-initial-review.md',
    ]);
  });
});
