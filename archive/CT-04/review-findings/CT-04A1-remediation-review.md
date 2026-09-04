# CT-04A1 remediation re-review

Prior review: `review-findings/CT-04/CT-04A1-initial-review.md`,
SHA-256 `db4454d735cb2e14188adcdd778001bc9d48695641403a011697095bace66a25` (unmodified)
Operator disposition: `work-items/CT-04/CT-04A1-initial-review-disposition.md`,
SHA-256 `d7931d2243d0459ed7ee9e3399cd266a4f37efa0e7776799e169e043a14f5662`
Remediation report: `implementation-reports/CT-04/CT-04A1-remediation.md`,
SHA-256 `33662244aab3e29ed07d325f03922602964c4f4db52aec77ff351b1d2338c8bf`
Reviewed initial head: `94465cb847e6571f2f10e55c0c3764bfa422646e`
Protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
Remediation head: **none — the remediation is an uncommitted working tree over `94465cb8…`**
Environment: Git `2.54.0`, Node `v26.2.0`, POSIX, effective UID `1000` (non-root).

## Verdict

**APPROVE**, subject to the commit condition below.

All four accepted remediations — `A1-R-01`, `A1-R-02`, `A1-R-04`, `A1-R-05` — are
closed, and I reproduced each fix independently rather than relying on the new tests.
`A1-R-03`, `A1-R-06`, and `A1-R-07` are correctly handled as documentation-only per the
operator disposition. I found no regression against any behaviour verified in the initial
review, and no CT-04A2 or CT-05+ scope leaked in.

Three new observations arise from the remediation itself (`A1-R-08` … `A1-R-10`). None is
blocking: none permits unauthorized host access, arbitrary execution, cross-workspace
corruption, destructive cleanup, false durable state, false complete evidence, or stale
cross-resource UI state. All three are fail-closed. They need operator disposition, not
rework before commit.

### Commit condition

The remediation exists only as working-tree modifications; `HEAD` is still `94465cb8…`.
There is no stable remediation head to certify, and process proof `P-PROCESS-003` requires
completion evidence to record a real stable head. The remediation report correctly states
"New exact head SHA: pending operator-authorized remediation commit", so this is a pending
operator action rather than an implementer defect.

This approval covers exactly the tree digested below. Re-verification after commit is
mechanical: confirm these twelve digests are what the commit contains.

```text
d483d190a8039fc4a7d0dfd8beb8da81b1bbed10746851ea9da087609b16a089  docs/architecture.md
fd8d70d7e9a528de781ab0179a4d1739d855afff233537da3ae29d2fdea9240b  docs/decisions/ADR-016-trusted-local-git-inspection-boundary.md
06f0f06e177e435e227229e7aa2c2f2b742e5c1c2663091875f3cd7648f92eea  docs/operations.md
b044cc19600eed6ff5ac8d933e8082bf57425ecff61931f488397a4477d931b7  implementation-reports/CT-04/CT-04A1-initial-impl.md
3d3c3d6a3b2fef8a43d071c557c4363794a5779a2e68a90f93476339e6a49bcb  packages/git/src/configuration.ts
3ccfaf3581afeb03b0f99982b3cf2ad7b7724cf15d374813342192f775b2f1e3  packages/git/src/path-policy.ts
5b1b7ff5838c9e63d7dc1b1090026de17852e29ef9130073ef49ccfbcb6fe8d7  packages/git/src/repository-inspector.ts
d9d5dd53f3321d6ae860a3567df18a5aa083964351c9c2cb2d1d8c4b9a88c354  packages/git/test/command-runner.test.ts
6806349b8c736e40db2082f2bdd8c16f0cf0305fe35c4afa1b64fb1aca924814  packages/git/test/configuration.test.ts
286c21587f20d99a6260da1c42d0c98f58d87b045abbba2da24bf265a54b34e7  packages/git/test/repository-inspector.test.ts
33662244aab3e29ed07d325f03922602964c4f4db52aec77ff351b1d2338c8bf  implementation-reports/CT-04/CT-04A1-remediation.md
d7931d2243d0459ed7ee9e3399cd266a4f37efa0e7776799e169e043a14f5662  work-items/CT-04/CT-04A1-initial-review-disposition.md
```

## Verification performed

**Provenance.** My initial review file is byte-unchanged (`db4454d7…`). The protected
package is still byte-identical to its pin: `git cat-file -e 06abcffe…^{commit}` succeeds
and `git diff --exit-code 06abcffe… -- protected/` is empty. Nothing under `protected/`
was edited.

**Scope.** The remediation touches 10 modified files plus 3 new artifacts. No file under
`apps/`, `packages/storage`, `packages/domain`, `packages/contracts`, `packages/planning`,
`packages/testing`, or `packages/agents` is touched. No schema, migration, route, event,
notifier, or browser file appears. `@craftingtable/git` still has no consumer beyond
`packages/testing`'s legacy type-only import.

**Full gate.** `pnpm check` run end to end on the remediated tree, exit 0: format, lint,
typecheck, build, 60 test files / **472 tests** (up from 465), 4 Playwright tests, scope
check, protected-package check. Focused run of `packages/git/test` plus both `.mjs` script
suites: 7 files / **80 tests** (up from 73). Both figures match the remediation report's
§4 claims exactly.

**Independent reproduction.** I re-ran every probe from the initial review against the
rebuilt `packages/git/dist`, plus new probes for the remediated code paths. Results below.

## Finding closure

### A1-R-01 — closed and verified

`packages/git/src/repository-inspector.ts:199-202` now returns `not-primary-repository`
unconditionally at the final supported-but-non-exact branch; the inverted ternary is gone.
`knownPrefix` still feeds `structurallyFramed`, so the structural-framing rejection is
preserved and `malformed-identity-output` remains reserved for unframable output.

Reproduced at unit level:

```text
strict-ancestor prefix (knownPrefix=true) -> not-primary-repository | repository-class-changed | not-retryable
unknown structural prefix                 -> not-primary-repository | repository-class-changed | not-retryable
unrelated top-level                       -> not-primary-repository | repository-class-changed
```

The first line was `malformed-identity-output` / `git-boundary-fault` / `retryable` at the
initial head. The new permanent test in `packages/git/test/command-runner.test.ts` drives
a non-empty `ancestorCandidates` list and asserts code, subject, and retryability — this
is the coverage the disposition required, and it now exists.

### A1-R-02 — closed and verified

`packages/git/src/path-policy.ts:301-309` rejects `dirname(requestedPath).includes(':')`
with `invalid-path` and evidence `{reason: 'ambiguous-git-ceiling'}`, placed after
normalization and before source-root matching, filesystem access, and any spawn.

Reproduced:

```text
[a:b]   inspect(inner) -> invalid-path | caller-input | {"reason":"ambiguous-git-ceiling"}
[plain] inspect(inner) -> not-primary-repository | repository-class-changed
```

A repository whose *basename* contains a colon still inspects successfully, matching the
disposition. The new test in `packages/git/test/repository-inspector.test.ts` proves
pre-spawn refusal with a counting proxy (spawn count unchanged at 1, the creation-time
version probe), and the new test in `packages/git/test/command-runner.test.ts` proves
Git's actual no-ascent behaviour against a plain nested empty `.git` — the behavioural
assertion I asked for in place of the previous env-var text assertion.

I re-examined `GIT_CEILING_DIRECTORIES` for other ambiguity vectors. The only list
metacharacter POSIX Git honours is the `:` separator, whose empty-entry form (`::`,
leading, or trailing) is itself a colon and therefore covered. There is no `!` negation or
escape syntax in this variable. Rejecting any colon in the parent is sufficient.

### A1-R-03 — closed as dispositioned (no code change)

Production behaviour is unchanged, as the operator directed. I re-confirmed the behaviour
is exactly as I originally characterised it: a single `writeFileSync` of an unrelated file
into the repository root during inspection still yields `observation-raced` /
`repository-unavailable`.

The documentation now says so plainly in three places —
`docs/decisions/ADR-016-…md` (consequences), `docs/operations.md`, and the erratum in
`implementation-reports/CT-04/CT-04A1-initial-impl.md` — and the initial report's
"structural or inode evidence" wording is corrected to "kind, device, inode, size, mtime,
or canonical resolution". The A2 constraint (register only against a clean, quiescent
working tree; retry only after activity stops) is recorded in the disposition,
`docs/architecture.md`, and `docs/operations.md`. This is the right resolution for a
deliberate policy choice: the code is unchanged and the contract now matches it.

### A1-R-04 — closed and verified

`packages/git/src/configuration.ts` now separates candidate discovery from viability.
`resolveExecutableCandidates` collects ordered, canonical-path-deduplicated candidates;
`resolveInspectorConfiguration` probes them in order and returns configuration only from
inside the per-candidate supported-version branch. Explicit executables return their probe
failure immediately and never fall back.

Reproduced:

```text
searchPath [git 2.31.1 stub, real git 2.54.0]  -> creates successfully (was: unsupported-git-version)
searchPath [git 2.31.1 stub only]              -> unsupported-git-version (first meaningful failure preserved)
same directory listed three times              -> 1 version probe (dedup works), unsupported-git-version
4 stale candidates + 1 good                    -> creates successfully, 4 stale probes then the good one
```

### A1-R-05 — closed and verified

`packages/git/src/configuration.ts:62` now uses `value === undefined ? defaultValue : value`
so only omission selects a default, and `validateOptionShape` gained `optionalString` /
`optionalNumber` predicates covering both executable strings and all five numeric bounds
before any platform, filesystem, or process authority is used.

Reproduced — all four now `invalid-options` / `policy-configuration` /
`configuration-required`:

```text
{commandTimeoutMs: null}   -> invalid-options   (was: silently defaulted, created OK)
{stdoutLimitBytes: null}   -> invalid-options   (was: silently defaulted, created OK)
{gitExecutable: 42}        -> invalid-options   (was: git-not-executable / host-environment / retryable)
{commandTimeoutMs: 1}      -> invalid-options   (unchanged, still correct)
```

### A1-R-06 and A1-R-07 — closed as informational A2 handoff

No code change, as I recommended and the operator confirmed. Both constraints are now
recorded in the disposition, `docs/architecture.md`, and — for `A1-R-07` — ADR-016's
consequences. I re-confirmed the underlying behaviour is unchanged: a disjoint reserved
root still yields `outside-allowed-root`, an overlapping one still fails creation with
`invalid-root-policy`, and `riskScan`, device evidence, `canonicalGitDirectory`, and
`observedAt` are still accepted by `parseRecordedObservation` after tampering while core
identity and fingerprint tampering are rejected.

## Regression assessment

Every behaviour I verified in the initial review still holds on the remediated tree:
newline-bearing basenames observed successfully; JSON round-trip and self-comparison
clean; core-identity and fingerprint tamper rejection intact; 257-short-key
`feature-count-exceeded` versus 200-long-key `stdout-overflow` precedence intact;
pre-aborted request returning `aborted` with no filesystem access; request-equals-root,
missing path, relative path, and symlinked request all classified as before; hooks
symlink recorded as a signal without following; overlapping reserved root rejected at
creation.

The test-only proxy change from `process.stdout.write` to `fs.writeSync` is confined to
`packages/git/test/` and does not alter production runner semantics. It is a correct fix
for a real nondeterminism — small payloads to a pipe are not guaranteed flushed before
child exit — and the remediation report discloses the five intermediate failures that
prompted it.

## New findings

### A1-R-08 — minor — a colon in a *configured source root* is diagnosed as caller input, not as root policy

- **Claim.** The `A1-R-02` guard tests `dirname(requestedPath)`, which includes the
  configured source root and everything above it. A source root that itself contains a
  colon — or any ancestor of it, such as a mount point like `/mnt/vol:1` — passes
  `createRootPolicy` at creation, but then makes *every* request beneath it fail with
  `invalid-path` / `caller-input`. The operator is never told their root is unusable, and
  per accepted plan §12.1 A2 maps `caller-input` to "request rejection without
  repository-state inference" — a misdirected diagnosis for what is a configuration fault.

- **Evidence.** `packages/git/src/path-policy.ts:301-309` performs the check per request.
  `createRootPolicy` (`packages/git/src/path-policy.ts:176-246`) validates absoluteness,
  normalization, symlink-freedom, existence, and pairwise non-overlap, but not ceiling
  representability.

- **Reproduction.** With `allowedSourceRoots: ['/tmp/root-XXXX/ro:ot']`, inspector
  creation returns `ok: true`; inspecting `/tmp/root-XXXX/ro:ot/repo` (a valid primary
  checkout) returns `invalid-path` / `caller-input` /
  `{reason: 'ambiguous-git-ceiling'}`. A reserved root containing a colon is likewise
  accepted at creation.

- **Required outcome.** A source root whose own path cannot be represented as an
  unambiguous ceiling should be refused at inspector creation as `invalid-root-policy` /
  `policy-configuration` / `configuration-required`, so the operator learns at composition
  time rather than through every subsequent request. The per-request guard should remain
  as the check for colons introduced below the root, where `caller-input` is the correct
  subject.

### A1-R-09 — minor — creation-time version probes are now unbounded and carry no aggregate deadline

- **Claim.** First-viable search means inspector creation may now spawn one `--version`
  probe per distinct search-path candidate rather than exactly one. There is no cap on
  candidate count and no total creation deadline, so worst-case creation latency is
  `candidates × commandTimeoutMs` (default 5000 ms each). Accepted plan §7.2's "Version
  runs once at inspector creation" is now stale; the `A1-R-04` disposition supersedes it
  in intent but the plan sentence was not amended.

- **Evidence.** `packages/git/src/configuration.ts` loops
  `executableResolution.candidates`, calling `runner.run({kind: 'version'}, undefined, …)`
  with `signal` undefined — no aggregate budget. Every other dimension in accepted plan
  §6.1 is explicitly bounded (roots 1–32, timeouts, byte limits, key counts); this one is
  not.

- **Reproduction.** A search path of four stale 2.31.1 proxies followed by a real Git
  produces four failed version spawns before succeeding. Duplicate entries resolving to
  the same canonical path are correctly deduplicated to one probe.

- **Required outcome.** Decide whether to bound the candidate list (consistent with the
  §6.1 bounds discipline), apply a total creation deadline, or accept the cost explicitly.
  Either way, accepted plan §7.2 and the `A1-GIT-018` spawn-count narrative should be
  reconciled so a future reviewer does not read "version runs once" as an invariant. The
  per-`inspect()` two-spawn invariant is unaffected and still proven.

- **Impact bound.** Low. Search-path content is operator-supplied, A2 is required to pass
  explicit policy, and ambient `PATH` is documented as development-only.

### A1-R-10 — informational — the ceiling-representability invariant is enforced away from where the ceiling is built

- **Claim.** The rule "the ceiling value contains no list separator" is enforced by a
  string predicate in `packages/git/src/path-policy.ts`, while the ceiling is constructed
  in `packages/git/src/environment.ts:33` as `dirname(command.cwd)`. Nothing at the
  construction site enforces the property. Today the only `identity` /
  `local-risk-signal-names` construction sites are in
  `packages/git/src/repository-inspector.ts`, using an admitted path, so the invariant
  holds — but a future slice adding a construction site would silently escape it.

- **Why this is worth recording.** This is the same containment shape rejected in design
  finding `A1-F-07`: a value-pattern check that a future caller escapes by not passing
  through the checking path, rather than a structural boundary that cannot be bypassed.
  The A1-F-07 remedy moved fixtures out of `src` entirely instead of excluding them by
  glob; the analogous remedy here derives or validates the ceiling where the command's
  environment is constructed, so no `FixedGitCommand` can exist with an unrepresentable
  ceiling.

- **Required outcome.** None in A1 — the current code is correct. Worth a decision before
  CT-04A2 or CT-04C adds command variants or call sites.

## Protected acceptance assessment

The protected package is unchanged and verified by both the history-independent manifest
checker and the pinned Git comparison.

The two parent mappings I reported as not discharged at the initial head are now
discharged. **REG-PATH-006** and **REG-PATH-008** hold through both the stderr path and
the exit-zero identity path, since the latter now classifies strict-ancestor and
different-top-level output as `not-primary-repository` / `repository-class-changed`.
`A1-PATH-028` is now proven behaviourally rather than by asserting the environment
variable's text, and `A1-F-01`'s honest-discrimination amendment has permanent coverage
with a non-empty `ancestorCandidates` list.

`A1-CFG-010` and `A1-CFG-012` are now proven by the new configuration tests.
`A1-PATH-014` remains discharged at creation time, as recorded under `A1-R-06`.

## Scope and downstream readiness

The remediation adds no schema, migration, SQLite row, repository state, ID, binding,
route, contract, authorization behaviour, audit action, event, notifier, transaction, or
browser behaviour. It adds no mutation, remote Git, credential handling, public process
carrier, or second production process authority. The single anchored
`node:child_process` import remains the only one, in both source and emitted `dist`, and
the export map remains `"."`-only.

Documentation quality is high. The erratum in `implementation-reports/CT-04/CT-04A1-initial-impl.md`
is the right pattern: it preserves the immutable initial-head record while marking exactly
which claim was too strong and why, instead of rewriting history. The remediation report
is candid about its intermediate failures, the sandbox `EPERM` rerun, and the two mistyped
`.ts` script paths that silently collected only five files — that last disclosure is the
kind of thing that is easy to omit and valuable to record.

**Recommended next step.** Commit the remediation so a real stable head exists, then
disposition `A1-R-08`, `A1-R-09`, and `A1-R-10`. `A1-R-08` is the only one I would want
resolved before CT-04A2 begins configuring real source roots.
