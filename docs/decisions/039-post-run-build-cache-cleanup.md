# ADR-039: Clean build caches when runs end

Status: accepted. Refines ADR-034 and ADR-037.

Recognized build caches no longer depend on merging a work item. Finished, failed and
cancelled runs become eligible after an observed process exit is recorded and no session in
their worktree remains live. A supervision error without observed exit does not authorize deletion. Runs marked
interrupted after daemon restart remain protected because their process completion was not
observed. Full scratch expiry retains its existing merged/removed and 30-day rules.

Both backends set CARGO_TARGET_DIR beneath the run's provided scratch directory. Briefs keep
verification logs, reports and preserved artifacts outside build caches and discourage reuse
of another run's cache. Cargo signatures, compiler metadata and a debug or release fingerprint
directory identify disposable caches, including nested reproduction directories up to four
levels below scratch. Unknown directories, symlinks and nested filesystems remain protected.
This does not infer deletion authority over source worktrees or arbitrary external caches.

After process-group exit, queue cleanup and keep that worktree's automation from advancing
until the attempt completes. Other worktrees can progress. Deletion takes the shared worktree
mutation guard and rechecks eligibility and filesystem identity. Manual launches await pending
post-run cleanup. Existing maintenance is allowed to finish first; queued requests are retained.
The periodic worker re-derives eligibility after restart and retries failures. Cleanup errors
surface through existing storage alerts and never rewrite a run's review outcome.

## Amendment 2026-09-24: one build cache per worktree (R-G7)

Every step used to build into its own `scratch/target`, which this ADR then removed when the
step ended. Each design, implement, review and remediation step therefore compiled cold. From
2026-09-13 to 2026-09-23 that removed 825 GB across 101 caches in 25 worktrees, about four cold
builds per worktree.

- **Shared cache.** The daemon now gives every run in a worktree the same Cargo target
  directory, `<runs root>/worktree-caches/<worktree id>`. It is registered in
  `worktree_build_caches` at the worktree's first launch, and Cargo creates it on the first
  build, so a worktree that never builds Rust leaves nothing to clean. Steps build incrementally. The
  worktree's runs are sequential, and Cargo locks its target directory as well.
- **Cleanup.** The cache is removed only once the worktree is merged or removed and no run in
  it is live. Removal takes the worktree's mutation guard, checks the registered path and
  device, never follows a link, and is audited as `storage.cleaned` with the worktree id. It is
  automatic under `autoCleanBuildCaches`: the storage worker's next tick, within a minute. When
  that setting is off, the Storage page's cleanup offers it instead.
- **Unchanged.** Per-run scratch caches, which older runs and agents that pick their own
  target still create, keep the rules above. Pinned-evidence and historical-baseline builds
  keep their per-run target directories, because their provenance is per run.
