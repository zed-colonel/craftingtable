/**
 * CT-01 defines only the smallest Git seam that demonstrates dependency
 * inversion. Real Git execution (worktrees, branches, commits, diffs) is
 * deferred to CT-04; no code in this repository may shell out to Git yet.
 */
export interface RepositorySnapshot {
  name: string;
  branch: string;
  headShaAbbrev: string;
  clean: boolean;
  /** CT-01 snapshots are always simulated. */
  simulated: true;
}

export interface GitService {
  describeRepository(): Promise<RepositorySnapshot>;
}
