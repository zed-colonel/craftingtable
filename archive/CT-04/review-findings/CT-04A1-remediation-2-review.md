# CT-04A1 remediation generation 2 re-review

Prior reviews: `review-findings/CT-04/CT-04A1-initial-review.md`,
`review-findings/CT-04/CT-04A1-remediation-review.md`
Invariant specification: `review-findings/CT-04/CT-04A1-remediation-2-invariant-spec.md`
Operator disposition and amendment:
`work-items/CT-04/CT-04A1-remediation-2-disposition-and-invariant-amendment.md`
Implementation report: `implementation-reports/CT-04/CT-04A1-remediation-2.md`
Generation-1 head: `2180ae187edc13ed35482c07f484d910f0265a56` (**verified**)
Generation-2 head: `7313e81a56c0188574c436322d7fedc16e08bb70` (**verified**; reviewed as an
uncommitted tree over `2180ae1`, then committed unchanged — the sixteen digests below are
the content of that commit)
Protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
Environment: Git `2.54.0`, Node `v26.2.0`, POSIX, effective UID `1000` (non-root).

## Verdict

**APPROVE.** No new findings.

A1-R-08, A1-R-09, and A1-R-10 are closed, each verified independently rather than by
trusting the new tests. The full regression set from both prior reviews passes unchanged.
No CT-04A2 or CT-05+ behaviour leaked in, and the protected package is untouched.

The commit condition is now satisfied. The reviewed tree was committed unchanged as
`7313e81a56c0188574c436322d7fedc16e08bb70`; each of the sixteen digests below was verified
against that commit's content after the fact. `implementation-reports/CT-04/CT-04A1-remediation-2.md`
was committed carrying its `pending` placeholder and then amended to record `7313e81a…`, so
its digest below is its pre-fill-in content — the same two-step pattern used for
generation 1 (protocol §8, `P-PROCESS-003`).

### Generation-1 verification

`2180ae1` was checked file-by-file against the twelve digests recorded in the
generation-1 re-review. All twelve match. My prior APPROVE stands for that head, and
`implementation-reports/CT-04/CT-04A1-remediation.md` now records `2180ae18…` as its real
head rather than a placeholder.

### Generation-2 tree under review

```text
f22929b4839295ecfa64a0f07e0e740622c82464b0a107f58e34bf8b4b49948e  docs/architecture.md
67ee4d690b4b525ad3a10c43626fe6fa5a982e5bb789549f141a76f11909f616  docs/decisions/ADR-016-trusted-local-git-inspection-boundary.md
3229ed428a43eb72604c89580b8092fd14cf0a7d6cca806ff8c5f7079c126796  docs/operations.md
4536c5a9289d78f0772ea15865602fc9194cf2ad9e079e19777dea6bc3069792  implementation-reports/CT-04/CT-04A1-remediation.md
52c148cc001ab515f68ce4f9c14e74dc39e51c3de1e92f4643c4737379bdea6a  packages/git/src/command-runner.ts
2d1793b8b8751fd848caeb1c612e27f2101ea9c342951dd6e10a12dbd5cfcb10  packages/git/src/configuration.ts
c916a2a1c0395afa2f1153d4a9264e41404e60a7b8c4bdb68e883aa56ce630ed  packages/git/src/environment.ts
7e96d0be4a3dad370ae19af803558df80d6025c3de13bda3e8197bf2513eb4b9  packages/git/src/path-policy.ts
b8b21768400f6c42700135d8175602454b134f7530d57f821f621b19689f45f0  packages/git/src/repository-inspector.ts
38c17f1a94d57cc4d1d4acaa0c49696f052b91571525aecdb98d353c463c539e  packages/git/src/types.ts
a8c2c43f9b8494e847521751865b1928908605b1a1b7f38720d0427454ac1559  packages/git/test/command-runner.test.ts
b980039ba1b8ca8beea05ab5c6a2042dc8c28387594d38b9ccd7c7552bfc1ab4  packages/git/test/configuration.test.ts
181e682fb96692b56eddac42c633605905a3a27d59538ba4b6d2a79774efaa4d  packages/git/test/path-policy.test.ts
8e2e0fd90857cdb71b066250a0e71ad0d1af364275ba150893fcdbfcaab6a947  packages/git/test/test-support.ts
ae84b7d40c6984e07f43f0cd2c63d269da7e0766fcb17167ec70b43ee51ded44  implementation-reports/CT-04/CT-04A1-remediation-2.md
0720d5de160f57217867cc5fcd10e1a9d1fcacb695bbeb0bcaba4deb78b0821b  work-items/CT-04/CT-04A1-remediation-2-disposition-and-invariant-amendment.md
```

## Verification performed

**Gate.** `pnpm check` exit 0: format, lint, typecheck, build, 60 test files / **476 tests**
(up from 472), 4 Playwright tests, scope check, protected-package check. Focused Git plus
script suites: 7 files / **84 tests** (up from 80). Both match the report's §6 claims.

**Protected package.** `git diff --exit-code 06abcffe… -- protected/` empty; the
history-independent manifest verifier passes. No protected file edited.

**Scope.** 14 modified files plus 2 new artifacts. Nothing under `apps/`,
`packages/storage`, `packages/domain`, `packages/contracts`, `packages/planning`,
`packages/testing`, or `packages/agents`. Emitted `dist` still contains exactly eight
production modules, `command-runner.js` remains the sole `node:child_process` importer,
and no test or fixture module is emitted.

## Finding closure

### A1-R-08 — closed and verified

`createRootPolicy` (`packages/git/src/path-policy.ts:203-212`) now calls the shared
predicate for every allowed source root. Both the policy-time and request-time checks call
`isGitCeilingDirectoryRepresentable`; neither contains a local colon literal, which was the
coupling I asked to remove.

Reproduced against real repositories:

```text
source root contains ":"          -> invalid-root-policy | policy-configuration | configuration-required
reserved root contains ":"        -> accepted at creation
colon component below clean root  -> invalid-path | caller-input | {reason:'ambiguous-git-ceiling'}
colon in repository basename      -> observed successfully
```

All four proof-obligation rows are satisfied, including the reserved-root row where I
required an asserted decision rather than incidental behaviour. The disposition's rationale
— reserved roots are never a working directory or ceiling source, so restricting them would
add unrelated policy — is correct, and I verified the premise directly: `environmentFor`
derives nothing, and commands are constructed only from `admitted.canonicalTopLevel` and
`allowedSourceRoots[0]`.

### A1-R-09 — closed and verified

The operator selected the aggregate deadline and no candidate cap.
`RepositoryInspectorOptions.creationTimeoutMs` defaults to `2 × commandTimeoutMs + 5000`,
bounded 1000–90000 ms and no shorter than `commandTimeoutMs`. One `AbortController` starts
before root-policy resolution, is checked through candidate discovery and before and after
each probe, and — importantly — is now **passed into every version runner**, so a version
subprocess is hard-bounded by the earlier of the per-command and aggregate deadlines.

Bounds matrix reproduced, all `invalid-options` / `policy-configuration`:

```text
creationTimeoutMs 999      creationTimeoutMs 90001     creation < command
creationTimeoutMs null     creationTimeoutMs 1000.5    creation == command -> accepted (boundary)
```

Enforcement reproduced with six hanging candidates, `commandTimeoutMs: 500`,
`creationTimeoutMs: 1000`:

```text
result   timed-out / git-boundary-fault
spawns   2 of 6            elapsed 1001 ms
spawns after settle  2     (did not grow)
```

This satisfies the disposition's requirement that expiry prevent every later candidate
spawn, and my "no further spawn afterwards" obligation. The previously unasserted canonical
deduplication is now covered by a permanent test, and I re-confirmed it independently
(three duplicate entries → one probe).

Contract reconciliation is handled: the disposition supersedes accepted plan §7.2's
"Version runs once at inspector creation" with an explicit replacement rule, and ADR-016's
consequences now state that explicit executable policy performs one probe while search
policy may probe multiple candidates within the aggregate deadline. The
per-`inspect()` two-spawn invariant is unchanged and re-proven.

### A1-R-10 — closed and verified, including at compile time

The structural shape is exactly what the amendment specifies:

- `GitCeilingDirectory`, `isGitCeilingDirectoryRepresentable`, and the checked constructor
  `createGitCeilingDirectory` live in `packages/git/src/environment.ts` — the module that
  owns the syntax now owns the validation.
- `environmentFor` copies `command.ceilingDirectory` and performs no derivation. `dirname`
  survives only inside the checked constructor.
- The union expresses the asymmetry: `version` carries only `CanonicalPath`; identity and
  risk require a `GitCeilingDirectory`.
- `CanonicalPath` and its named mint `asCanonicalPath` live in `path-policy.ts`, minted in
  production only at `path-policy.ts:258-259` (root policy) and `:515-516` (admission).
- The `as string` cast at the old `configuration.ts:285` is gone; the version cwd is now a
  branded value with an explicit `undefined` guard.

I proved the boundary at compile time rather than accepting it by inspection. Compiling a
probe that constructs commands from ordinary strings produces:

```text
TS2322  cwd: '/tmp/x'                  -> string is not assignable to CanonicalPath
TS2322  ceilingDirectory: '/tmp'       -> string is not assignable to GitCeilingDirectory
TS2322  expectedTopLevel / expectedGitDirectory -> string is not assignable to CanonicalPath
TS2322  {kind:'local-risk-signal-names', cwd} -> property 'ceilingDirectory' is missing
```

Neither brand nor mint appears in `packages/git/src/index.ts`; the export map remains
`"."`-only. The test-only mint `canonicalPathForTest` lives in
`packages/git/test/test-support.ts`, so the unsafe construction path sits structurally
inside the boundary A1-F-07 established — the outcome I asked for.

The backstop assertions exist at `packages/git/test/configuration.test.ts:398-418`: single
production owner for `GIT_CEILING_DIRECTORIES`, for `asCanonicalPath(`, and for the
`as GitCeilingDirectory` cast, plus negative assertions on `index.ts` and on the removed
`as string`. The report correctly labels these secondary to the structural types rather
than the source of correctness.

I also confirmed there is no runtime import cycle: `environment.ts` imports `CanonicalPath`
type-only, and the emitted `dist/environment.js` imports only `node:path`.

### Repeated invariant-class record

The disposition and the report both state plainly why the plan's typing was dropped:
implementation convenience at a private interface, where runtime checks appeared sufficient
and the structural-authority consequence was missed, and that this was the same invariant
class as A1-F-07. That is the datum I asked for, recorded without hedging, and it is the
most useful thing this slice produces for protocol §13.

## Regression assessment

Every behaviour verified across both prior reviews still holds:

strict-ancestor identity → `not-primary-repository` / `repository-class-changed` /
`not-retryable`; colon parent refused pre-spawn while the plain nested case still returns
`not-primary-repository`; search-path fall-through and first-meaningful-failure; `null`
bounds and non-string `gitExecutable` → `invalid-options`; newline-bearing basename
observed; JSON round-trip and self-comparison clean; core-identity and fingerprint tamper
rejection with `riskScan`/device/`canonicalGitDirectory`/`observedAt` still unauthenticated
as dispositioned under A1-R-07; 257-short-key `feature-count-exceeded` versus 200-long-key
`stdout-overflow` precedence; pre-aborted request → `aborted` with zero filesystem access;
request-equals-root, missing path, relative path, symlinked request; hooks symlink recorded
without following; overlapping reserved root refused at creation; `observation-raced` still
produced by ordinary top-level working-tree writes, per the accepted A1-R-03 policy.

## Observations — not findings, no action required

1. **Union excess-property nuance.** A `version` command literal may syntactically carry a
   `ceilingDirectory` without a type error, because TypeScript permits properties present
   in any member of a union. This is not a hole: a `GitCeilingDirectory` cannot be obtained
   without the checked constructor, and `environmentFor` never reads one for `version`.
2. **Short `creationTimeoutMs` with a slow first candidate.** Because the rule is
   `creationTimeoutMs >= commandTimeoutMs` rather than `>= N × commandTimeoutMs`, a single
   slow candidate can consume the whole creation budget, so a viable Git later in the
   search path is never reached and creation returns `timed-out` rather than
   `unsupported-git-version` or `git-not-found`. The subject is `git-boundary-fault` /
   `retryable`, which is the correct handling, and the behaviour is documented. Worth
   remembering when A2 chooses production values.
3. **Cooperative bounds persist.** Root-policy and executable-evidence filesystem work is
   checked around, not preempted, because Node cannot interrupt a kernel-blocked syscall.
   The report states this in its limitations.

## Slice readiness

Against protocol §12 merge evidence, CT-04A1 now has: accepted implementation plan;
independent design review and dispositions; completion report with a real head for
generation 1; full deterministic gate passing; protected acceptance evidence; independent
code review plus two remediation reviews; and no unresolved blocking or high findings.

The slice-level evidence is therefore complete at `7313e81a…`. Per operator direction the
merge into `ct-04` waits until CT-04A2 lands, so the remaining §12 gate — Keith's merge
decision — is deliberately deferred rather than outstanding. Nothing in A1 blocks A2
planning from starting against this head.

Two limitations carried forward, both previously accepted and neither a defect:
`riskScan`, device evidence, `canonicalGitDirectory`, and `observedAt` are validated but
not cryptographically authenticated, so A2 owns full-record storage integrity (A1-R-07);
and ordinary top-level working-tree activity can produce `observation-raced`, so A2 must
register against a quiescent tree (A1-R-03).

One gap in my own coverage, unchanged across all three reviews: the ownership-refusal and
root-daemon paths have not been exercised against a real second UID or real root. They rest
on injected-dependency tests, which pass. Closing that needs a test host with a second
account.
