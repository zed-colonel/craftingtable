import type { RepositoryCheckDeclaration } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { type BuildReceipt, declaredCheckGaps } from './build-receipt-policy.js';

const check = { id: 'tests', argv: ['scripts/check.sh'], definitionPaths: ['scripts/check.sh'] };
const declaration = (
  id: string,
  digest: string,
  changes: Partial<typeof check> = {},
): RepositoryCheckDeclaration =>
  ({
    id,
    version: 1,
    checks: [{ ...check, ...changes }],
    definitionDigests: { 'scripts/check.sh': digest, Makefile: 'm'.repeat(64) },
  }) as unknown as RepositoryCheckDeclaration;
const ran = (declarationId: string, digest: string): BuildReceipt =>
  ({
    success: true,
    clean: true,
    headSha: 'h',
    manifestDigest: 'm',
    runId: 'r',
    runtimeId: 't',
    declaredCheck: {
      id: 'tests',
      declarationId,
      definitionDigests: { 'scripts/check.sh': digest },
    },
  }) as BuildReceipt;
const held = declaration('held', 'a'.repeat(64));
const edited = 'b'.repeat(64);
const gaps = (adoptedSince?: RepositoryCheckDeclaration) =>
  declaredCheckGaps(held, [ran('held', edited)], () => true, adoptedSince);

it('a check that ran with other definitions is changed, unless the same command with those definitions was adopted since (R-G13 review)', () => {
  expect(gaps().changed).toEqual([{ checkId: 'tests', paths: ['scripts/check.sh'] }]);
  expect(gaps(declaration('later', edited)).changed).toEqual([]);
  // A later adoption of other definitions, or of another command, clears nothing.
  expect(gaps(declaration('later', 'c'.repeat(64))).changed).toHaveLength(1);
  expect(
    gaps(declaration('later', edited, { argv: ['scripts/check.sh', '--quick'] })).changed,
  ).toHaveLength(1);
  expect(
    gaps(declaration('later', edited, { definitionPaths: ['scripts/check.sh', 'Makefile'] }))
      .changed,
  ).toHaveLength(1);
  expect(gaps(declaration('later', edited, { id: 'other' })).changed).toHaveLength(1);
  // A receipt under another declaration never counts; the check is missing.
  expect(declaredCheckGaps(held, [ran('other', 'a'.repeat(64))], () => true).missing).toEqual([
    'tests',
  ]);
});
