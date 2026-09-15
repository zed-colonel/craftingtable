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
