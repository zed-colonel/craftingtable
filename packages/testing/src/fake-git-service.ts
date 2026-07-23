import type { GitService, RepositorySnapshot } from '@craftingtable/git';

export const FAKE_REPOSITORY_SNAPSHOT: RepositorySnapshot = {
  name: 'craftingtable',
  branch: 'ct-01/fake-demo',
  headShaAbbrev: '0000000',
  clean: true,
  simulated: true,
};

export class FakeGitService implements GitService {
  constructor(private readonly snapshot: RepositorySnapshot = FAKE_REPOSITORY_SNAPSHOT) {}

  describeRepository(): Promise<RepositorySnapshot> {
    return Promise.resolve(this.snapshot);
  }
}
