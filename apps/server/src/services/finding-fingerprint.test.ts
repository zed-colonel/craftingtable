import { expect, it } from 'vitest';
import { findingFingerprint } from './scope-recovery-policy.js';

it('fingerprints a finding apart from its ID and named owner, so naming an owner does not hide a repeat (LIVE-27 review)', () => {
  const finding = { id: 'F-1', status: 'open', severity: 'major', title: 'Same defect' };
  const renamed = { ...finding, id: 'R1.F-1' };
  const owned = { ...finding, owningSlice: 'wi/WI-03/integration' };
  const other = { ...finding, title: 'Another defect' };
  const fingerprint = findingFingerprint([finding]);
  expect(findingFingerprint([renamed])).toBe(fingerprint);
  expect(findingFingerprint([owned])).toBe(fingerprint);
  expect(findingFingerprint([other])).not.toBe(fingerprint);
});
