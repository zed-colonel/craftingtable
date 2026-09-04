# CT-04A1 independent code review

Reviewed implementation head: `94465cb847e6571f2f10e55c0c3764bfa422646e`
Implementation commit: `acc5cb685a7ed9ff1d1cdadac3df6f9ec30ce2c8`
Base / protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
Accepted implementation plan: `work-items/CT-04/CT-04A1-accepted-implementation-plan.md`
Completion report: `implementation-reports/CT-04/CT-04A1-initial-impl.md`
Review checkout: `94465cb8…`, branch `ct-04a-git-foundation`, working tree clean before and after.
Local environment: Git `2.54.0`, Node `v26.2.0`, POSIX, effective UID `1000` (non-root).
All probes ran in a scratch directory outside the repository. Nothing in the repository
was modified by this review.

## Verdict

**CHANGES REQUIRED**

One blocking finding. `A1-R-01` inverts the identity failure classifier for exactly the
strict-ancestor case that accepted amendment `A1-F-01` was raised to fix, so a genuine
repository-class replacement is handed to CT-04A2 as a retryable `git-boundary-fault`
instead of a non-retryable `repository-class-changed`. `A1-R-02` makes that branch
reachable during ordinary operation and independently breaks the `A1-PATH-028` ceiling
invariant, so the two should be remediated together.

Everything else in the slice is faithful to the accepted plan, and several areas are
materially stronger than the plan's minimum. The boundary, command surface, constructed
environment, taxonomy, export map, and emitted-dist proofs all hold under independent
probing. No CT-04A2 or CT-05+ behaviour leaked in.

## Verification performed

**Checkout and provenance.** `git rev-parse HEAD` = `94465cb8…`; working tree clean.
`94465cb` adds only the completion report (1 file, 423 lines). `acc5cb6` is the
implementation commit with exactly 29 changed/new files, 4,647 insertions and 50
deletions, matching accepted plan §4 file-for-file and the report's §1 claim.

**Protected package.** `git cat-file -e 06abcffe…^{commit}` succeeds;
`git diff --exit-code 06abcffe… -- protected/` is empty. Live SHA-256 values:
`protected/README.md` = `4e857aca74d4c96f869a2f30e73f0aeb0153f8de2c0e77f972fea325647119fd`,
`protected/CT-04-protected-acceptance-spec.yaml` =
`ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`.
Proposal `74685e13…`, design review `c329b274…`, and operator disposition `333fdfca…`
all match the accepted plan's stated provenance exactly.

**Full gate.** `pnpm check` run end to end at head, exit 0: format, lint, typecheck
(including `packages/git/tsconfig.test.json`), build, 60 test files / 465 tests, 4
Playwright tests, scope check, protected-package check. The report's §8 figures reproduce
exactly. Focused run of `packages/git/test` plus both script suites: 7 files / 73 tests,
matching the report's 53 + 20 split.

**Emitted boundary.** `packages/git/dist` contains only the eight production modules;
`command-runner.js` is the only emitted module importing `node:child_process`; no test or
fixture module is emitted. The only workspace consumer of `@craftingtable/git` remains
`packages/testing`'s type-only legacy `GitService` / `RepositorySnapshot` imports.

**Adversarial probes.** Run against real temporary Git repositories built outside the
repository, plus unit-level calls into `packages/git/dist`. Coverage: nested-repository
ceiling behaviour with and without a colon in the path; identity classification across
strict-ancestor, unknown-structural, and unrelated prefixes; concurrent working-tree
writes during inspection; newline/space/dash basenames; JSON round-trip of a live
observation followed by seven tamper mutations; request-equals-root, reserved overlap,
missing path, relative path, symlinked request; 257-short-key versus 200-long-key
overflow precedence; pre-aborted signal; tight total inspection budget; nested reserved
root; hooks-directory symlink; executable search-path fall-through; option-shape edges.
I separately confirmed Node emits `close` after a spawn `error`, so the runner's
resolve-on-close design cannot hang on spawn failure.

## Findings

### A1-R-01 — blocking — identity classifier returns `malformed-identity-output` for the strict-ancestor case the plan assigns to `not-primary-repository`

- **Claim.** In `parseIdentityOutcome` the final classification ternary is inverted. When
  Git emits a well-framed identity block whose path prefix matches a strict-ancestor
  candidate recorded during admission, the code returns `malformed-identity-output`
  (`git-boundary-fault`, `retryable`). When the prefix is *not* recognised, it returns
  `not-primary-repository` (`repository-class-changed`, `not-retryable`). The plan
  requires the opposite for the recognised case.

- **Evidence.** `packages/git/src/repository-inspector.ts:176` computes `knownPrefix` over
  `expectedPrefix` plus the ancestor templates.
  `packages/git/src/repository-inspector.ts:200-206` then returns
  `knownPrefix ? 'malformed-identity-output' : 'not-primary-repository'`.

  Reaching that return with `knownPrefix === true` implies the prefix is a *strict
  ancestor* template: a prefix equal to `expectedPrefix` carrying a supported tail is
  already consumed by the byte-equality success check at
  `repository-inspector.ts:147-155`, and the bare / inside-work-tree / object-format tail
  variants are filtered at `repository-inspector.ts:188-199`.

  Accepted plan §10.2 states: "supported tail plus a path prefix that resolves to a strict
  ancestor top-level or a different top-level/Git/common directory →
  `not-primary-repository`", and "only output that cannot be structurally framed as three
  NL-terminated path fields and three NL-terminated tokens is
  `malformed-identity-output`". The structural-framing rejection already happens at
  `repository-inspector.ts:178-187`, so nothing correct remains for the final `malformed`
  branch.

- **Violated invariant / acceptance IDs.** Accepted plan §10.2 and §12; review finding
  `A1-F-01` (operator disposition "accepted as recommended"; accepted plan §21 maps it to
  sections 10, 12, 14.2); proof obligations `A1-PATH-016`, `A1-PATH-019`, `A1-PATH-027`,
  `A1-PATH-028`, `A1-EVID-004`. Also contradicts completion report §4 ("rejected with
  repository-class failures rather than parse-corruption failures") and §5's
  honest-discrimination claim.

- **Reproduction.** Unit level, no filesystem or Git required:

  ```js
  import { parseIdentityOutcome } from 'packages/git/dist/repository-inspector.js';
  const top = '/src/roots/outer/inner', gitd = `${top}/.git`;
  const anc = '/src/roots/outer',       ancGit = `${anc}/.git`;
  const out = (s) => ({ commandKind: 'identity', stdout: Buffer.from(s),
                        stderr: Buffer.alloc(0), exitCode: 0 });

  parseIdentityOutcome(out(`${anc}\n${ancGit}\n${ancGit}\nfalse\ntrue\nsha1\n`), top, gitd, [anc]);
  // observed: malformed-identity-output | git-boundary-fault      | retryable
  // required: not-primary-repository    | repository-class-changed | not-retryable

  parseIdentityOutcome(out(`${anc}\n${ancGit}\n${ancGit}\nfalse\ntrue\nsha1\n`), top, gitd, []);
  // observed: not-primary-repository (correct)
  // -> confirms the branch is inverted, not merely strict
  ```

  Reproduced end to end through a real repository as well: a nested checkout under a
  source root whose parent basename contains `:` returns `malformed-identity-output`,
  while the identical structure without the colon returns `not-primary-repository`.

  The existing suite cannot catch this. Every case in
  `packages/git/test/command-runner.test.ts:265-294` passes `ancestorCandidates: []`, so
  the `knownPrefix === true` branch has no test at all.

- **Required outcome.** A well-framed identity block whose prefix matches a recorded
  strict-ancestor template must classify as a repository-class change, so CT-04A2 receives
  `repository-class-changed` / `not-retryable` and blocks rather than scheduling a retry.
  `malformed-identity-output` must be reserved for output that cannot be structurally
  framed. The permanent proof matrix needs at least one case driving this branch with a
  non-empty `ancestorCandidates` list; without it the `A1-F-01` amendment remains unproven
  however the code is corrected.

### A1-R-02 — major — `GIT_CEILING_DIRECTORIES` is written as a single unescaped path into a colon-separated variable, defeating the discovery ceiling

- **Claim.** Git parses `GIT_CEILING_DIRECTORIES` as a `:`-separated list. The runner
  assigns the admitted path's parent verbatim, so any `:` in that parent splits the value
  into fragments, none of which is an ancestor of the working directory. Git then ascends
  freely to a parent repository. Colons are legal in POSIX directory names, and the plan
  explicitly requires metacharacter paths to be admitted (`A1-PATH-021`).

- **Evidence.** `packages/git/src/environment.ts:31-34` returns
  `GIT_CEILING_DIRECTORIES: dirname(command.cwd)` with no escaping, splitting, or
  rejection. `packages/git/src/path-policy.ts:298-344` admits paths containing `:` without
  restriction. The test at `packages/git/test/command-runner.test.ts:83` asserts only that
  the variable equals `dirname(hostile)`; it never asserts that Git cannot ascend.

- **Violated invariant / acceptance IDs.** Accepted plan §8.1 ("The ceiling prevents Git
  from discovering an ancestor repository"); proof obligation `A1-PATH-028` ("ceiling
  present in nested-repo case | Git cannot ascend").

- **Reproduction.** Repository at `<root>/a:b`, nested request at `<root>/a:b/inner`
  holding an empty `.git`, invoked with the exact environment the runner constructs:

  ```text
  [a:b]   ceiling=/tmp/ceil-…/roots/a:b     git ascended to: /tmp/ceil-…/roots/a:b
  [plain] ceiling=/tmp/ceil-…/roots/plain   git ascended to: <git refused: fatal: not a git repository…>
  ```

  The colon case escapes the ceiling; the control does not.

- **Required outcome.** Either the constructed ceiling value must be guaranteed
  unambiguous for every admitted path, or paths for which no unambiguous ceiling can be
  expressed must be refused before any spawn. In both cases `A1-PATH-028` needs a probe
  asserting Git's *behaviour* under the ceiling, not the environment variable's textual
  value.

  Scope note for the implementer: this is defence in depth. With `A1-R-01` corrected, the
  raw-byte prefix comparison still contains the ascent, and no observation is ever
  produced for a repository the caller did not request. I found no path by which the
  ceiling bypass alone yields unauthorized observation.

### A1-R-03 — moderate — postflight compares directory mtime and size, so ordinary working-tree activity produces a false `observation-raced`

- **Claim.** `verifyPathSnapshots` compares `mtimeNanoseconds` and `size` in addition to
  kind, device, and inode. Creating, deleting, or renaming any entry in the repository
  root updates that directory's mtime, so a concurrent build, editor save, or package
  install during inspection fails the whole inspection as a race.

- **Evidence.** `packages/git/src/path-policy.ts:518-531` compares all five snapshot
  fields; the snapshot set includes the top-level working-tree directory
  (`packages/git/src/path-policy.ts:491`). Accepted plan §9.2 step 15 scopes this to a
  "structural/inode race", and §9.3 describes postflight as detecting "path/layout/inode
  replacement".

- **Violated invariant / acceptance IDs.** Accepted plan §9.2 step 15 and §9.3; interacts
  with `A1-PATH-022` and the §18.4 A2 obligation to run "two complete inspections, the
  second immediately before storage".

- **Reproduction.** A baseline inspection of a quiet repository succeeds. The same
  inspection with a single `writeFileSync(<repo>/concurrent-build-output.txt)` issued 2 ms
  after the call returns `observation-raced` / `repository-unavailable`. No structural or
  inode evidence changed.

- **Required outcome.** Postflight must fail only on the evidence the plan names — kind,
  device, inode, and canonical resolution — or the plan's race definition must be widened
  deliberately and A2 told that registration of an actively-used repository will fail
  intermittently. As written the behaviour is fail-closed and cannot produce a false
  observation, but it makes CT-04A2 registration of a live working tree unreliable in
  exactly the dogfood case the plan targets.

### A1-R-04 — minor — executable search path does not fall through when the first candidate fails its version probe

- **Claim.** The search loop returns the first absolute entry containing an executable
  `git` and stops. The version probe runs once, after the loop. A first entry holding an
  unsupported Git aborts inspector creation instead of continuing to the next entry.

- **Evidence.** `packages/git/src/configuration.ts:138-146` returns on first match; the
  probe and version gate are at `packages/git/src/configuration.ts:272-305`, outside the
  loop. Accepted plan §6.2: an entry is "accepted only if that target is a regular
  executable whose version probe passes."

- **Violated invariant / acceptance IDs.** Accepted plan §6.2; proof obligation
  `A1-CFG-012`.

- **Reproduction.** `executableSearchPath = <dir with a 2.31.1 stub>:<dir with real git
  2.54.0>` returns `unsupported-git-version` with evidence
  `{gitMajor: 2, gitMinor: 31, gitPatch: 1}` rather than resolving the second entry.

- **Required outcome.** Decide and record whether search-path resolution is first-match or
  first-*viable*-match, make the code and `A1-CFG-012` agree, and state the choice in
  `docs/operations.md`, since A2 production configuration is required to supply an
  explicit search path. Behaviour is fail-closed either way.

### A1-R-05 — minor — two option-validation gaps in the configuration boundary

- **Claim.** (a) An explicit `null` for any numeric bound is silently coerced to the
  default rather than rejected. (b) A non-string `gitExecutable` is reported as
  `git-not-executable` (`host-environment`, `retryable`) rather than `invalid-options`
  (`policy-configuration`, `configuration-required`).

- **Evidence.** `packages/git/src/configuration.ts:62` — `const candidate = value ??
  defaultValue` treats `null` as absent. `packages/git/src/configuration.ts:111-117`
  returns `git-not-executable` for a non-string. `validateOptionShape`
  (`packages/git/src/configuration.ts:177-192`) validates only the two root arrays and the
  key set.

- **Violated invariant / acceptance IDs.** Proof obligation `A1-CFG-010`
  ("invalid/noninteger/incoherent bounds | reject"); accepted plan §12 subject mapping.

- **Reproduction.** `{commandTimeoutMs: null}` and `{stdoutLimitBytes: null}` both create
  successfully. `{gitExecutable: 42}` yields `git-not-executable` / `host-environment` /
  `retryable`. For contrast, `{commandTimeoutMs: 1}` correctly yields `invalid-options`.

- **Required outcome.** A caller-supplied `null` bound should be rejected as an invalid
  option, and a malformed `gitExecutable` should carry the configuration subject so A2's
  §12.1 handoff routes it to configuration repair rather than retry.

### A1-R-06 — informational — `reserved-root-overlap` is unreachable at inspection time

- **Claim.** The inspect-time reserved-root check is dead code. `createRootPolicy` already
  rejects any reserved root overlapping a source root in either direction, and every
  admitted request is strictly below a source root. Because all ancestors of a path form a
  chain, a request cannot overlap a reserved root without its source root also overlapping
  that reserved root — which configuration already refuses.

- **Evidence.** `packages/git/src/path-policy.ts:228-237` (configuration-time cross-set
  rejection) versus `packages/git/src/path-policy.ts:318-323` (inspect-time check).
  Probes confirm `reservedRoots: [<inside a source root>]` fails creation with
  `invalid-root-policy`, and a request under a disjoint reserved root returns
  `outside-allowed-root`, never `reserved-root-overlap`.

- **Required outcome.** No code change required; the code is conservative and correct.
  Record that `A1-PATH-014` is discharged by configuration-time rejection, so a future
  reviewer does not read the unreachable branch as tested coverage and A2 does not build
  handling for a subject it can never receive.

### A1-R-07 — informational — the core fingerprint covers only core identity, leaving risk-scan, device, `canonicalGitDirectory`, and `observedAt` unauthenticated

- **Claim.** `parseRecordedObservation` recomputes only the seven-field core fingerprint.
  A recorded observation whose `riskScan.signals`, `environmentalEvidence`,
  `canonicalGitDirectory`, or `observedAt` has been altered parses successfully and
  compares as identical on those axes.

- **Evidence.** `packages/git/src/comparison.ts:43-51` enumerates the hashed fields;
  `packages/git/src/comparison.ts:256-265` verifies only that digest. This matches accepted
  plan §5 and §11.1 exactly — it is conformant, not a defect.

- **Reproduction.** Mutating `coreIdentity.topLevelInode`,
  `coreIdentity.fingerprintSha256`, or `observationVersion` is correctly rejected.
  Mutating `riskScan.signals` (with a matching `classification`),
  `environmentalEvidence.topLevelDevice`, `canonicalGitDirectory`, or `observedAt` is
  accepted.

- **Required outcome.** Nothing in A1. This belongs in the A2 handoff: accepted plan §18.5
  and §18.8 direct A2 to parse every stored observation and to treat scan evidence as
  durable, but `parseRecordedObservation` authenticates only core identity. A2 must supply
  its own storage integrity for the unhashed fields, or the fingerprint scope must be
  widened under a later reviewed policy version.

## Protected acceptance assessment

The protected package is byte-identical to its pin by both the history-independent
verifier and the pinned Git comparison. Nothing under `protected/` was touched.

The A1 contributions to the parent protected-equivalent cases hold as mapped in accepted
plan §15, with one exception. **REG-PATH-006** and **REG-PATH-008** are mapped to
`A1-PATH-016` and `A1-PATH-018`/`A1-PATH-019` — the nested-subdirectory and non-primary
layout classifications. Those classify correctly through the *stderr* path ("not a git
repository" with a recorded ancestor marker). They do **not** hold through the exit-0
identity path, which `A1-R-01` misclassifies. Because `A1-R-02` makes the exit-0 path
reachable for ordinary colon-bearing paths, these two mappings are not fully discharged at
this head.

Verified sound and reproduced independently:

- exact raw-byte identity success including newline-bearing basenames
  (`A1-EVID-003`, `A1-PATH-021`);
- NUL-record risk-signal parsing with invalid-UTF-8 rejection (`A1-EVID-005`);
- exit-1-with-empty-streams as `no-signals-in-scanned-set` versus exit-1-with-output as a
  typed failure (`A1-EVID-006`);
- byte-overflow precedence over record count — 257 short keys give
  `feature-count-exceeded`, 200 long keys give `stdout-overflow` at a 16384 floor
  (`A1-GIT-022`);
- pre-aborted request returning `aborted` before filesystem access (`A1-GIT-013`);
- hooks-directory symlink recorded as a signal without following (`A1-PATH-020`);
- symlinked request rejected (`A1-PATH-015`);
- request equal to a source root rejected (`A1-PATH-010`);
- nested reserved root rejected at configuration (`A1-PATH-006`, `A1-PATH-007`);
- export map `"."`-only with no raw runner, argv, or environment carrier reachable from
  the entry point (`A1-GIT-020`, `A1-BND-005`);
- single anchored `node:child_process` import in both source and emitted dist
  (`A1-GIT-019`, `A1-BND-004`);
- total code→subject mapping with compile-time exhaustiveness (`A1-EVID-023`).

The constructed child environment matches accepted plan §8.1 exactly — ten fixed fields,
no `process.env` clone, no `HOME`, no `PATH` — and the three command variants match §7.2
verbatim.

## Scope and downstream readiness

No CT-04A2 or CT-05+ behaviour leaked in. The diff touches no schema, migration, SQLite
row, HTTP or SSE contract, route, service, authorization path, audit action, event kind,
notifier, or browser file. `apps/server` still does not import `@craftingtable/git`; the
only workspace consumer remains `packages/testing`'s type-only legacy import, exactly as
accepted plan §3.1 describes. No durable-state vocabulary (`active`, `unavailable`,
`identity-mismatch`, `reaffirmed`, `retired`) appears on the public surface. Production
inspection creates no host file.

Documentation is accurate and does not overclaim. README and CLAUDE identify accepted
CT-03 as the composed runtime and A1 as an uncomposed active slice. ADR-016 uses "durable"
only to defer it to A2 and CT-04C. No readiness or completion language is attached to A1.

The completion report is honest about its commands and intermediate failures, including
the sandbox `EPERM` reruns and the CommonJS-to-ESM proxy correction, and its gate figures
reproduce exactly at this head. Its §4 claim that mismatches are "rejected with
repository-class failures rather than parse-corruption failures" is the one statement
contradicted by `A1-R-01`, and the report should be corrected alongside the code.

## Remediation guidance

Suggested order, and what the re-review will check:

1. **`A1-R-01` and `A1-R-02` together.** `A1-R-02` is `A1-R-01`'s reachability vector, and
   fixing only one leaves a named proof obligation broken. Re-review will drive the
   `knownPrefix === true` branch directly with a non-empty `ancestorCandidates` list, and
   will assert Git's actual ascent behaviour under a colon-bearing parent rather than the
   ceiling variable's text.
2. **`A1-R-03`** before A2 rather than after. It cannot corrupt anything, but it makes A2
   registration flaky against live working trees, which is the intended first workload.
3. **`A1-R-04` and `A1-R-05`.** Small and fail-closed; resolve the specification ambiguity
   in `A1-R-04` explicitly rather than silently matching the code to current behaviour.
4. **`A1-R-06` and `A1-R-07`.** No code change. Carry both into the A2 handoff record so
   A2 does not assume coverage it will not receive.

Re-review will re-verify the head SHA, provenance hashes, the protected pin, the full
`pnpm check` gate, the emitted-dist and export-map boundaries, and every probe listed
under **Verification performed**, not only the code changed in remediation.
