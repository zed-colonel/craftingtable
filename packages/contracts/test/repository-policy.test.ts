import { expect, it } from 'vitest';
import { saveRepositoryPolicyRequestSchema } from '../src/repository-policy.js';
it('accepts explicit local policy without accepting invented remote verification or abbreviated freeze identities', () => {
  const input = {
    expectedVersion: 0,
    expectedBranchSettingsVersion: 1,
    controlMode: 'controller-local',
    interpretation: 'Controller-gated local integration.',
    publicationRequirement: 'Before remote publication.',
    experimentalFreeze: { branch: 'main', commitSha: 'a'.repeat(40) },
  };
  expect(saveRepositoryPolicyRequestSchema.safeParse(input).success).toBe(true);
  for (const invalid of [
    { ...input, controlMode: 'github-protected' },
    { ...input, remoteProtectionVerified: true },
    { ...input, experimentalFreeze: { branch: 'main', commitSha: 'aaaaaaa' } },
    { ...input, experimentalFreeze: { branch: '--upload-pack=bad', commitSha: 'a'.repeat(40) } },
    { ...input, interpretation: '' },
  ])
    expect(saveRepositoryPolicyRequestSchema.safeParse(invalid).success).toBe(false);
});
