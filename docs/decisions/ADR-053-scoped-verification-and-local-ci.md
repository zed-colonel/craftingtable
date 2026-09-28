# ADR-053: Scope-specific verification and local CI

Status: accepted
Date: 2026-09-17

A repository-wide dependency generation describes the target stack; it must not force
independent contract/domain slices to port legacy runtime code before their integration scope.
Derive a versioned verification policy from the exact adopted map. Domain slices without assigned
AQ baseline cases use scoped checks. Independent implementation slices qualify only when their
explicit gates contain no upstream runtime obligations. Parent acceptance qualifies only when
all its required/evidence slices and acceptance requirements qualify. Integration, conformance,
release, unknown scopes and finalization retain current pinned Cargo verification. This policy
changes build applicability only: phase gates, case coverage, independent review, parent obligations
and final promotion authority remain unchanged.

Scoped runs can use explicitly prepared historical dependency commits, freshly exported from Git;
missing preparation never authorizes registry fallback for configured upstream packages. Current
integration pins are never replaced. Historical characterization remains a separate immutable-source
launcher; it never produces candidate acceptance evidence. Candidate checks record the exact clean
commit, runtime generation, manifest digest and policy digest. A scoped receipt cannot satisfy a
current-upstream build gate. Future provider branch movement alone does not block independent
checks; required runtime evidence still checks freshness. Changing the active generation still
invalidates prior review evidence.

The agent receives `ct-check` for repository-owned checks and `ct-act` for one repository workflow
and optional job. (2026-09-28, R-G4: `ct-check` is a request to the daemon, which runs the command in
a confined user unit and records the receipt in its database; receipts an agent can write no longer
satisfy a scoped gate. See `docs/security.md`.) These are process adapters inside an already authorized agent run, not browser
command endpoints. A separate named adapter owns this authority. Local CI uses operator-configured
executables, a Unix Docker socket, image digest and cache location. Rootless Docker is preferred.
The runner receives exact dependency configuration and sources; scripts must consume that config.
CI is supplemental to the current-pinned Cargo gate for integration, not an alternative attestation
of resolution. It is supplemental to scoped checks too (2026-09-28, R-G4): a scoped review needs a
ct-check, pinned Cargo or native receipt, and a checkpoint candidate needs the kind its mode requires. Existing native/Kata evidence gates remain distinct.

Each act invocation has one job at a time, bounded time/output, CPU/memory limits, a run lease,
retained log/receipt, and labelled container cleanup. Terminal/restart cleanup runs outside database
transactions. Uncollected CI cannot produce a passing frozen build record. Host credential files and
the Docker socket are not mounted into jobs. These controls coordinate trusted repository code under
the existing OS-user model; they are not a hostile-code security boundary or GitHub-equivalent policy
engine. Workflow permissions, environments and concurrency cannot be inferred from act execution.

Actions and Cargo download caches live in configured CI storage; targets remain registered run
scratch and receive ordinary post-run cleanup. Logs and explicit artifacts remain outside scratch.
Images and shared download caches are retained, not automatically globally pruned. This first adapter
uses mounted local artifacts rather than GitHub cache/artifact servers or external qualification hosts.

Evidence and native approval applicability across dependency generations are refined by
[ADR-058](ADR-058-reviewed-dependency-refresh.md); original run/receipt provenance remains immutable.

Independent parent acceptance (2026-09-22 clarification): an explicitly independent parent with
only eligible slices, no assigned AQ cases and an accepted predecessor in the same repository
retains scoped checks. That predecessor is a sequencing/acceptance gate, not implicit runtime
coupling. Cross-repository, self, missing or unclassified requirements and explicit upstream
obligations retain current-upstream checks. No acceptance requirement is removed by classification.
