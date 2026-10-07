import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { runBuildRecordSchema, runEnvironmentSchema } from '../src/persisted-records.js';

/**
 * R-G13 increment 4: a run environment without a runtime is a check-only run's. It must be held
 * to an adopted declaration, recorded by the daemon, and hold nothing a pinned run would.
 */
it('accepts a run environment without a runtime only when it is check-only (R-G13 increment 4)', () => {
  const pinned = {
    runId: 'run-1',
    workspaceId: 'workspace-1',
    runtimeId: randomUUID(),
    manifestPath: '/runs/run-1/dependencies/manifest.json',
    manifestDigest: 'a'.repeat(64),
  };
  expect(runEnvironmentSchema.safeParse(pinned).success).toBe(true);
  const { runtimeId: _runtime, ...withoutRuntime } = pinned;
  const checkOnly = {
    ...withoutRuntime,
    receiptAuthority: 'daemon',
    checkDeclarationId: randomUUID(),
  };
  expect(runEnvironmentSchema.safeParse(checkOnly).success).toBe(true);
  for (const invalid of [
    withoutRuntime,
    { ...checkOnly, checkDeclarationId: undefined },
    { ...checkOnly, receiptAuthority: undefined },
    { ...checkOnly, verificationMode: 'current-upstream-build' },
    { ...checkOnly, nativeApprovalId: randomUUID() },
    { ...checkOnly, architectureDecisionDigest: 'b'.repeat(64) },
  ])
    expect(runEnvironmentSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
  // Its build record has no runtime either.
  expect(
    runBuildRecordSchema.safeParse({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      manifestDigest: 'a'.repeat(64),
      receipts: '',
      digest: 'c'.repeat(64),
    }).success,
  ).toBe(true);
});
