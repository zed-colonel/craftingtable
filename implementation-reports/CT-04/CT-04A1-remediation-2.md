# CT-04A1 Remediation Generation 2 Invariant-Closure Report

**Work item:** CT-04A1 — Trusted Git inspection boundary
**Review addressed:** `review-findings/CT-04/CT-04A1-remediation-review.md`
**Invariant specification:** `review-findings/CT-04/CT-04A1-remediation-2-invariant-spec.md`
**Operator disposition and amendment:** `work-items/CT-04/CT-04A1-remediation-2-disposition-and-invariant-amendment.md`
**Generation-1 head:** `2180ae187edc13ed35482c07f484d910f0265a56`
**Protected-package pin:** `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
**New exact head SHA:** pending operator-authorized generation-2 commit

## 1. Summary

Remediation generation 2 closes A1-R-08, A1-R-09, and A1-R-10.
Source-root policy now fails fast when no unambiguous POSIX Git ceiling can
exist. Inspector creation has one aggregate deadline across root resolution,
candidate discovery, and every first-viable version probe. The private command
boundary now structurally distinguishes canonical paths from proven ceiling
values, and environment construction serializes rather than derives the
ceiling.

The implementation keeps the same three fixed Git command variants and the
same single process authority. It adds no CT-04A2 behavior.

## 2. A1-R-08 — root policy owns ceiling representability

**Generalized invariant.** An allowed source root that makes every descendant
ceiling unrepresentable is a policy-configuration fault at inspector creation.
Caller-input classification is reserved for an ambiguous component introduced
below an otherwise usable root.

**Root cause.** Generation 1 checked only `dirname(requestedPath)`. Root-policy
creation admitted a colon-bearing source root and every later request failed as
caller input.

**Analogous surfaces inspected.**

- Existing and nonexistent allowed roots.
- Existing and nonexistent reserved roots.
- Colons in an allowed root, an ancestor of the allowed root, a component
  below the root, and the exact repository basename.
- Version commands, which carry no ceiling.
- Identity and risk commands, whose ceiling derives from the admitted
  repository path.
- Root overlap, canonicality, and symlink checks.

Reserved roots do not flow to a command working directory or ceiling. They
therefore retain no colon restriction.

**Repair.** `createRootPolicy` calls the environment module's shared
representability predicate for every allowed source root and returns
`invalid-root-policy` when it fails. The per-request check calls the same
predicate and retains `invalid-path` with
`{reason: 'ambiguous-git-ceiling'}`.

**Positive tests.**

- A colon-bearing reserved root is accepted when canonical and disjoint.
- A repository with a colon only in its basename still observes successfully.
- Existing clean source-root and primary-repository observations still pass.

**Negative/adversarial tests.**

- A colon-bearing source root fails inspector creation with
  `invalid-root-policy` / `policy-configuration` /
  `configuration-required`.
- A colon below a clean source root still fails before repository spawn as
  caller input.

**Why the defect class is closed.** The module that owns ceiling syntax exports
one predicate. Both policy-time and request-time decisions call it; neither
contains a local colon literal. Classification now follows the authority that
introduced the ambiguous component.

**Remaining limitations.** This is fail-fast diagnosis, not a new access
defense. Colon-bearing allowed roots are intentionally unsupported. Reserved
roots may contain colons because they never become ceilings.

## 3. A1-R-09 — bounded inspector creation

**Generalized invariant.** Inspector creation admits no unbounded
input-proportional process work. Every version process is bounded individually,
and all root resolution, candidate discovery, and probes share one aggregate
deadline.

**Root cause.** First-viable search changed one version probe into one probe per
distinct candidate without adding an aggregate budget.

**Analogous surfaces inspected.**

- Explicit executable policy versus search policy.
- Invalid, missing, symlinked, duplicate, stale, viable, slow, and replaced
  candidates.
- Per-command timeout versus aggregate creation timeout.
- Root-policy filesystem work and executable-evidence filesystem work.
- Aggregate expiry before a probe, during a probe, and between probes.
- Successful inspection after creation.

**Repair.** `RepositoryInspectorOptions` adds optional
`creationTimeoutMs`, defaulting to `2 × commandTimeoutMs + 5000`, bounded to
1000–90000 ms and no shorter than `commandTimeoutMs`. One abort controller
starts before root-policy resolution, is checked throughout candidate
discovery and between probes, and is passed into every version runner. Expiry
returns `timed-out` and prevents all later candidate spawns.

The operator selected no candidate cap. Canonical-path deduplication remains
ordered and exact.

**Positive tests.**

- Three stale candidates followed by one viable candidate cause exactly four
  version probes and successful creation.
- Duplicate search entries resolving to one canonical executable cause exactly
  one probe.
- Exact timeout bounds and omitted defaults remain accepted.
- One successful inspection still performs exactly two repository subprocesses
  after creation.

**Negative/adversarial tests.**

- Two slow stale candidates followed by a viable candidate exceed the 1000 ms
  aggregate deadline, return
  `timed-out` / `git-boundary-fault` / `retryable`, and record exactly two
  probes—the third is never started.
- `creationTimeoutMs` below 1000, shorter than `commandTimeoutMs`, noninteger,
  or `null` returns `invalid-options`.

**Why the defect class is closed.** Every version runner receives the same
aggregate abort signal, and the loop checks expiry before and after each
probe. Candidate discovery checks the signal before and after each filesystem
candidate lookup. No branch can advance to a later spawn after aggregate
expiry.

**Remaining limitations.** Node cannot preempt a kernel-blocked filesystem
syscall, so root and executable discovery are cooperatively bounded. Process
lifetime remains hard-bounded while the parent lives. Search candidate count
is not capped because the operator selected the aggregate-deadline remedy.

## 4. A1-R-10 — structural ceiling boundary

**Generalized invariant.** A repository Git command cannot be constructed
without a canonical working directory and an already proven representable
ceiling. The module that owns `GIT_CEILING_DIRECTORIES` syntax owns ceiling
validation and construction.

**Root cause.** The accepted plan specified branded command paths, but initial
implementation used plain strings and relied on runtime admission. The typing
was dropped for private-interface convenience because runtime checking seemed
sufficient. That missed the future-call-site authority consequence and
repeated the A1-F-07 invariant class: a structural boundary was replaced by a
value-pattern convention.

**Analogous surfaces inspected.**

- All three fixed command variants.
- The version-probe working directory.
- Both repository command construction sites.
- Source roots and reserved roots as possible ceiling sources.
- Every direct command construction in structural tests.
- Every production cast to either new brand.
- Every production `GIT_CEILING_DIRECTORIES` occurrence.
- All argv and child-environment construction sites.
- Package exports and emitted production modules.

`argumentsFor` remains the only argv constructor. It contains only fixed
tokens. `environmentFor` remains the only child-environment constructor.

**Repair.**

- `CanonicalPath` and its named unsafe mint live in `path-policy.ts`. Production
  minting occurs only after root-policy validation and path admission.
- `GitCeilingDirectory`, its representability predicate, and its checked
  constructor live in `environment.ts`.
- `RootPolicy` and `AdmittedRepositoryPath` carry internal brands.
- The version variant takes only `CanonicalPath`.
- Identity and risk variants require `CanonicalPath` plus
  `GitCeilingDirectory`; identity expected paths are branded.
- `environmentFor` copies `command.ceilingDirectory` and performs no derivation.
- The prior `configuration.ts` `as string` cast is gone.
- Direct test construction uses test-only mint helpers under
  `packages/git/test/`.

**Positive tests.**

- A safe canonical repository path produces the expected branded ceiling.
- All fixed argv and exact constructed-environment tests pass.
- Real Git no-ascent, newline basename, colon basename, and ordinary
  observation cases pass unchanged.

**Negative/adversarial tests.**

- The checked ceiling constructor rejects a canonical path whose parent
  contains a colon.
- Production-source backstops assert that
  `GIT_CEILING_DIRECTORIES` occurs only in `environment.ts`, canonical-path
  mint calls occur only in `path-policy.ts`, and the ceiling-brand cast occurs
  only in `environment.ts`.
- The public entry point contains no brand or mint export, and the export map
  remains `"."` only.
- Emitted output contains no test or fixture module and retains the sole
  `node:child_process` owner.

**Why the defect class is closed.** TypeScript cannot construct a repository
command from an ordinary string. The only production canonical mint is at the
path-policy authority boundary; the only ceiling mint validates syntax in the
environment module. Pattern assertions are secondary regression backstops to
the structural types.

**Remaining limitations.** Type brands are compile-time authority within the
package; JavaScript cannot enforce them at runtime. The closed production
construction sites remain protected by runtime path and ceiling validation.

## 5. Permanent proof mapping

| Finding / obligation | Permanent proof |
| --- | --- |
| A1-R-08 source-root diagnosis | `packages/git/test/path-policy.test.ts` — colon source rejected at creation with exact subject/retryability |
| A1-R-08 reserved-root decision | `packages/git/test/path-policy.test.ts` — disjoint colon reserved root accepted |
| A1-R-08 request/basename split | `packages/git/test/repository-inspector.test.ts` — colon parent pre-spawn refusal and colon basename success |
| A1-R-09 N stale then viable | `packages/git/test/configuration.test.ts` — four probes asserted before success |
| A1-R-09 canonical dedup | `packages/git/test/configuration.test.ts` — three duplicate entries produce one probe |
| A1-R-09 aggregate expiry | `packages/git/test/configuration.test.ts` — two slow probes, typed timeout, no third spawn |
| A1-R-09 per-inspection invariant | `packages/git/test/repository-inspector.test.ts` — exactly two repository spawns after creation |
| A1-R-10 checked ceiling | `packages/git/test/command-runner.test.ts` — safe construction and ambiguous rejection |
| A1-R-10 command/environment structure | `packages/git/test/command-runner.test.ts` and `packages/git/test/configuration.test.ts` — branded construction, sole syntax/mint owners, public/export/dist boundary |

All generation-1 regression probes remain in the focused 84-test Git and
script suites.

## 6. Verification actually run

```text
pnpm exec tsc --noEmit -p packages/git/tsconfig.test.json
  initial run: exit 1 because test declarations still reflected pre-build
  production output

pnpm exec tsc -b packages/git --force
  first run: exit 2; exposed the remaining unbranded version cwd
pnpm exec tsc -b packages/git --force
pnpm exec tsc --noEmit -p packages/git/tsconfig.test.json
  next run: test typecheck exposed five direct unbranded RootPolicy fixtures
pnpm exec tsc -b packages/git --force
pnpm exec tsc --noEmit -p packages/git/tsconfig.test.json
  final run: exit 0

pnpm exec biome format --write <ten changed TypeScript files>
pnpm exec tsc -b packages/git --force
pnpm exec tsc --noEmit -p packages/git/tsconfig.test.json
pnpm exec vitest run \
  packages/git/test/configuration.test.ts \
  packages/git/test/path-policy.test.ts \
  packages/git/test/command-runner.test.ts \
  packages/git/test/repository-inspector.test.ts
  exit 0; 4 files / 54 tests passed

pnpm format:check
pnpm lint
pnpm typecheck
  exit 0

pnpm exec vitest run packages/git/test \
  scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.test.mjs
  exit 0; 7 files / 84 tests passed

pnpm check
  approved unsandboxed run: exit 0
  format, lint, typecheck, build passed
  60 test files / 476 tests passed
  4 Playwright tests passed
  scope and history-independent protected checks passed

git cat-file -e \
  06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4^{commit}
  exit 0
git diff --exit-code \
  06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4 -- protected/
  exit 0
git diff --check
  exit 0
```

## 7. Protected-package verification

The correct pin exists locally. The history-independent checker passed inside
`pnpm check`, both checker test suites passed in the focused run, and
`protected/` is byte-identical to the pin. No protected file was edited.

## 8. Known limitations

- Only non-root POSIX operation with Git 2.32.0 or newer is supported.
- Allowed source-root paths containing `:` are rejected; reserved roots may
  contain it because they never become ceilings.
- Creation and inspection filesystem deadlines remain cooperative around
  kernel-blocked syscalls.
- Search candidate count is not capped; aggregate time bounds process work.
- Ordinary top-level working-tree activity can conservatively produce
  `observation-raced`.
- The core fingerprint does not authenticate every serialized observation
  field; A2 owns full-record storage integrity.
- Hard daemon death has no bounded orphan-lifetime guarantee.

## 9. Explicit CT-04A2+ scope check

This generation creates no schema, migration 0003, SQLite row, repository
state, inspection record, ID, binding, route, HTTP/SSE contract, authorization
response, audit action, workspace event, transaction, notifier call, or
browser behavior. It adds no change request, branch, checkout, worktree
mutation, status, diff, artifact store, agent, verification runner, arbitrary
process, remote Git, credential, or hosted-provider behavior.

The sole production process authority and three fixed Git command kinds are
unchanged.
