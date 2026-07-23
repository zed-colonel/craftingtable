import { describe, expect, it } from 'vitest';
import { FakeGitService } from './fake-git-service.js';

describe('FakeGitService', () => {
  it('returns a simulated repository snapshot', async () => {
    const snapshot = await new FakeGitService().describeRepository();
    expect(snapshot.simulated).toBe(true);
    expect(snapshot.name).toBe('craftingtable');
    expect(snapshot.branch).not.toHaveLength(0);
    expect(snapshot.clean).toBe(true);
  });
});
