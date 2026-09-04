# CT-04A1 design review

Reviewed proposed plan: `work-items/CT-04/CT-04A1-proposed-implementation-plan.md`
sha256 `74685e1385970ef29165a7c5291d6de30bb7294a0ec0e043886e9088318b9aa0` (untracked at review time)
Source baseline (pinned): `abc5f37815ad76430cae989224afde817d77a047`
Protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
Review checkout: `c42907b249578eca8ba51638543a069b8e0e880c`, branch `ct-04a-git-foundation`
Protected spec observed: `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`;
`protected/README.md` `4e857aca74d4c96f869a2f30e73f0aeb0153f8de2c0e77f972fea325647119fd`;
`git diff --exit-code 06abcff -- protected/` exits 0. All four literal hashes in §2 and §17 are correct.
Local Git: `2.54.0`. Probes were run in a scratch directory; nothing in the repository was modified.

Operator disposition of this review is recorded in section
[Operator dispositions and required plan amendments](#operator-dispositions-and-required-plan-amendments).

## Verdict

**PASS WITH ACCEPTED AMENDMENTS**

The declared facts in this plan are correct — every one I could reach was verified.
`packages/git/src/index.ts` is the bare CT-01 seam; `packages/git/package.json` already
depends on domain and `tsconfig.base.json` sets `"types": ["node"]` with `@types/node`
resolvable from the workspace root, so the no-manifest-change claim holds for
dependencies; the vitest `node` project already globs `packages/*/src/**/*.test.ts` and
`scripts/**/*.test.mjs`; `apps/server` imports neither seam and `packages/testing`
imports `@craftingtable/git` **type-only**, so nothing pulls `child_process` into the
daemon; the forbidden-scope checker behaves as described; `README.md` says CT-03 at both
the baseline and HEAD, matching §2.1's drift correction.

I also executed the two production commands under the exact constructed environment
(`env -i` with only the ten declared variables) and both succeed with no `HOME` and no
`PATH`. The lowercase-key correction in §2.2 is right, and the raw-byte identity
template is the correct answer to REG-PATH-012.

It is not a clean PASS because three specification defects would each produce a wrong or
unreviewable implementation, and the first is demonstrated below with a reachable case.
All findings are local amendments — none changes the A1/A2 boundary, the authority
count, or the split decision.

## Findings

### A1-F-01 — High — The exact-template identity parse conflates repository-class rejection with malformed output, defeating three protected cases

- **Claim.** §8.2 requires the identity command's *entire* stdout to equal a constructed
  template, and classifies every deviation as `unsupported-object-format` or
  `malformed-identity-output`. But §14.2 rows A1-PATH-016/017/019 declare the expected
  outcome `not-primary-repository`, and §13's taxonomy contains that code. Under the
  specified parser it is unreachable from admission step 10. Real, reachable
  repository-class rejections are therefore reported as parse corruption.
- **Evidence.** Three probes against Git 2.54.0, all with `.git` present as a directory
  so §11.2 step 7 admits them:
  - **Stray `.git` directory inside a repository** (`mkdir -p outer/sub/.git`, requesting
    `outer/sub`): `rev-parse` walks *past* the incomplete `.git` and returns the outer
    repository — `--show-toplevel` is `…/outer`, not the request. Prefix mismatch →
    `malformed-identity-output`. The honest classification is `not-primary-repository`,
    and this is exactly REG-PATH-006 ("repository subdirectory rather than top-level").
  - **`core.bare = true` in a repository that has a `.git` directory**: `rev-parse` exits
    **128** with `fatal: this operation must be run in a work tree` — no parseable tail
    at all. Per A1-GIT-016 this becomes `git-command-failed`, not
    `not-primary-repository`. That is REG-PATH-007 ("bare repository → rejected").
  - **`core.worktree` redirection**: `--show-toplevel` returns the redirected directory
    (outside the request) and `--is-inside-work-tree` is `false`. Prefix mismatch →
    `malformed-identity-output`.

  All three fail closed, which is correct and worth crediting. None produces a
  classification an operator or A2 can act on.
- **Violated.** REG-PATH-006, REG-PATH-007, REG-PATH-008; internal consistency between
  §8.2 and §14.2; process protocol §5 ("tests that prove examples but not invariants").
- **Required plan change.** Keep the whole-output byte equality as the *acceptance* test
  — it is the right newline-safe design and must survive. Add a discrimination step on
  failure: split the *tail* (the fixed-width, path-free suffix) into its three fields and
  classify `--is-bare-repository=true` or `--is-inside-work-tree=false` as
  `not-primary-repository`; classify a top-level that is a strict ancestor of the request
  as `not-primary-repository`; classify an unknown object-format token as
  `unsupported-object-format`; reserve `malformed-identity-output` for output that is not
  structurally three NL-terminated path fields plus three NL-terminated tokens.
  Separately, state that a nonzero exit carrying the stable C-locale
  `must be run in a work tree` diagnostic maps to `not-primary-repository`, exactly as
  §11.3 already does for the dubious-ownership diagnostic. Then correct the
  A1-PATH-016/017/019 expected values to the code the parser actually yields.
- **Suggested adversarial case.** A fixture matrix requesting, in turn: a directory
  containing an empty `.git` dir nested inside a real repository; a repository with
  `core.bare=true` and a `.git` directory; a repository with `core.worktree` pointing
  outside the request; and a genuinely corrupt stdout (truncated final newline). Assert
  four *distinct* codes, and assert that no two collapse into
  `malformed-identity-output`.

### A1-F-02 — High — The typed failure taxonomy gives A2 no axis on which to map failures to durable state

- **Claim.** §13 defines 24 error codes across nine categories plus a `retryability` field
  (`retryable | configuration-required | not-retryable`). Neither axis tells A2 which
  failures mean *the repository is temporarily unavailable* (non-terminal), which mean
  *the registered identity is gone* (terminal), which mean *the caller's input was bad*,
  and which mean *the host or configuration is broken*. §20's handoff rules cover only
  the three **success**-path difference tiers. The failure path — where REG-ID-002,
  REG-ID-005 and REG-ID-006 live — has no rule at all.
- **Evidence.** §15.2 already asserts one mapping in passing (REG-ID-005 → "durable
  unavailable state, not retirement") without stating a general rule that produces it.
  Concrete unresolved cases, all reachable on re-inspection of an already-registered
  repository: `symlink-rejected` because a path component was replaced with a symlink;
  `outside-allowed-root` because the operator edited `allowedSourceRoots`;
  `ownership-refused` because the directory was `chown`ed; `not-primary-repository`
  because the repository was converted; `git-executable-changed` after a system update.
  Each has a different durable consequence, and three of them are arguably identity
  replacement rather than unavailability. `retryability` groups them wrongly:
  `ownership-refused` and `outside-allowed-root` are both `configuration-required`, yet
  one should block and one should not touch identity at all.
- **Violated.** CT04-I05 (detection must be meaningful); REG-ID-005 ("unavailable, not
  silently retired"); REG-ID-006; operator disposition §4.2 and §8 Step 2 ("define the
  observational output and error model").
- **Required plan change.** Add a second, orthogonal, A1-declared field to every failure —
  a `subject` or `disposition-class` — with a closed vocabulary such as
  `caller-input | policy-configuration | host-environment | repository-unavailable |
  repository-class-changed | git-boundary-fault`, and give the complete code→class table
  in the plan. State explicitly that the class is A1's *observation* of what the failure
  is about and that A2 still owns the durable state it implies, so the boundary rule in
  the disposition is not weakened. Also state what A2 is expected to do when a
  re-inspection fails entirely and therefore no `RepositoryObservation` exists to compare
  — `compareRepositoryObservations` is unreachable on that path, and §12.3 does not say
  so.
- **Suggested adversarial case.** A table-driven test asserting the declared class for
  every one of the 24 codes, with a compile-level exhaustiveness guard so a code added in
  a later slice cannot be introduced without a class. Plus a permanent test that
  re-inspecting a registered repository whose path component became a symlink yields a
  class distinguishable from the class produced by deleting the directory.

### A1-F-03 — High — Recorded observations cross a persistence boundary with no parse contract and no version-mismatch rule

- **Claim.** `compareRepositoryObservations(recorded, current)` is the seam across which
  A2 will feed a value it read back out of SQLite, possibly written months earlier by a
  different A1 version. The plan versions the observation (`observationVersion: 1`,
  `inspectionPolicyVersion: 1`) but exports no parser or validator for a recorded
  observation, and states no behaviour when the two versions differ.
- **Evidence.** §6's public API exposes `inspect`, `createRepositoryInspector`, and
  `compareRepositoryObservations` and nothing else. §20 rule 4 says "A2 stores immutable
  inspection evidence" — i.e. serialized JSON — and rule 7 gives A2 the storage layer. In
  a `"strict": true` project a structurally-wrong deserialized object still type-checks at
  the call site if A2 casts, and a *missing* field compares equal to a missing field: two
  absent inodes produce `sameCoreIdentity: true`. A corrupt or truncated stored row
  therefore reports "identity unchanged" — the opposite of fail-closed, on the one
  function whose output gates CT04-I05. The `fingerprintSha256` compounds this: §12.1
  calls it "versioned" but does not say the version is inside the digest input, so a
  policy-version bump silently changes the digest of an unchanged repository.
- **Violated.** CT04-I05; CT04-I18 (evidence is immutable, and must therefore remain
  interpretable); source assessment §6 defect class 3 ("weak runtime boundary schemas" —
  the recurring CT-03 defect this protocol exists to prevent).
- **Required plan change.** Export a total
  `parseRecordedObservation(value: unknown): RecordedObservationResult` that validates
  structure and both version fields, and make `compareRepositoryObservations` accept only
  parsed values (branded, or accept the result type). Define the version rule explicitly:
  an unknown or higher `observationVersion` is a typed failure, never a comparison; a
  differing `inspectionPolicyVersion` with the same observation version must be surfaced
  as its own comparison outcome (feature evidence collected under a different scan policy
  is not comparable), not folded into `sameExternalExecutionEvidence`. State that the
  fingerprint input begins with both version numbers.
- **Suggested adversarial case.** Feed the comparison a stored observation with (a) a
  missing `coreIdentity.topLevelInode`, (b) `observationVersion: 2`, (c)
  `inspectionPolicyVersion: 2` with identical core fields, (d) inode values as JSON
  numbers rather than decimal strings, and (e) a truncated JSON object. All five must be
  typed failures; none may return `sameCoreIdentity: true`.

### A1-F-04 — Medium — The reserved-root policy invents a configuration constraint that binds CT-04C and CT-04D

- **Claim.** §11.1 requires the artifact root and managed-worktree root to be **strict
  descendants of the data root**. No governing document imposes that. CT04-I04 requires
  only that a repository be inside an allowed source root and *outside* the data and
  managed-worktree roots; REG-PATH-009 and REG-PATH-010 require only rejection of
  overlap; `CT-04-implementation-guidance.md` §4 lists `CRAFTINGTABLE_WORKTREE_ROOT` and
  `CRAFTINGTABLE_ARTIFACT_ROOT` as independent absolute paths.
- **Evidence.** §11.1's bullet "absolute normalized artifact and managed-worktree reserved
  paths that are strict descendants of the data root"; the derivation that follows
  ("Since both must be below the data root … registration cannot enter either reserved
  area") uses the invented constraint to *shorten the proof*. The cheaper and more general
  rule — reject overlap between each source root and each reserved subtree in both
  ancestor directions, which §11.1 already states for the data root — gives the same
  guarantee without constraining anyone. Meanwhile `artifactRoot` and
  `managedWorktreeRoot` are **required, non-optional** options, so A2 — which has no
  artifact store and no worktrees — must invent values for both to call the factory.
- **Violated.** Parent §5 ("No slice may silently absorb the next slice"); CT-04A
  non-goals; parent §12.
- **Required plan change.** Drop the descendant requirement and replace it with pairwise
  non-overlap between every source root and every reserved root, in both directions, plus
  pairwise non-overlap among the reserved roots. Change the options to a single
  `reservedRoots: readonly string[]` (or make the two fields optional with the policy
  stated for the empty case), so A1 does not require A2 to name CT-04C/D concepts. If the
  descendant layout is wanted as deployment policy, it belongs in `docs/operations.md`
  where CT-04C and CT-04D can revisit it, not as a library validation they cannot.
- **Suggested adversarial case.** Configuration cases where the artifact root is a sibling
  of the data root on another filesystem, where the worktree root is an ancestor of a
  source root, and where the artifact root equals the worktree root. The first must be
  **accepted**; the second and third rejected.

### A1-F-05 — Medium — The external-execution boundary statement enumerates unscanned *files* but not unscanned *config-key classes*, and the classification names overclaim

- **Claim.** §12.2 lists five surfaces "deliberately not enumerated", all of them files. It
  says nothing about the config keys the eight-alternative regex does not match. A
  repository with `alias.x = !sh -c …`, `merge.<driver>.driver`, `core.sshCommand`,
  `credential.helper`, `init.templateDir`, `uploadpack.packObjectsHook`,
  `core.alternateRefsCommand`, `sequence.editor`, `gpg.program`, `trailer.<t>.command`,
  `submodule.<n>.update = !cmd`, or `core.worktree` is classified `none-observed` — and A2
  will persist that verdict as immutable evidence, and CT-04C will consult it before
  checking files out.
- **Evidence.** §8.2's regex; §12.2's vocabulary `'none-observed' | 'risk-observed'`. The
  `core.worktree` probe under A1-F-01 shows a key that silently redirects Git's view of
  the working tree and is absent from both the regex and the signal vocabulary. The plan's
  defence ("These surfaces cannot cause external execution in the accepted A1 command
  set") is true and honest *for A1*, but the artifact A1 emits outlives A1's command set —
  that is the whole point of A2 storing it.
- **Violated.** CT04-I17; REG-ID-008; CT-04A binding decision "It may not ignore the
  question"; F-08's accepted disposition ("document which surfaces are intentionally not
  enumerated and why").
- **Required plan change.** Do not add a command — the operator's F-08 disposition forbids
  that, correctly. Instead: (a) rename the classification so the durable record is
  self-describing — `no-signals-in-scanned-set` / `signals-observed`, or keep the names and
  add a mandatory `scannedKeyPatterns` / `scanScopeVersion` field carrying the literal
  regex used, so a stored row proves what was and was not looked at; (b) extend §12.2's
  exclusion list with the config-key classes above, named individually, with the reason
  each is inert under A1's two read-only commands; (c) add `core.worktree` to the signal
  vocabulary as a layout-redirection signal — it is cheap, already visible to `--local`,
  and A1-F-01 shows it is otherwise reported as malformed output.
- **Suggested adversarial case.** A fixture with `alias.pwn=!touch /tmp/pwned`,
  `merge.custom.driver=false`, and `core.worktree=…` set only in `.git/config`. Assert the
  observation records the scan scope, that no `/tmp/pwned` appears, and that the durable
  evidence cannot be read as "this repository has no external-execution features."

### A1-F-06 — Medium — Fixture construction has no environment isolation; the operator's own global Git config can invalidate the feature and hook cases

- **Claim.** §16 lists seven fixture commands with `-c user.name`, `-c user.email`, and
  `--no-gpg-sign`, but specifies no environment for them. They will run under the
  developer's inherited environment and therefore under `~/.gitconfig`.
- **Evidence.** A global `init.templateDir` causes `git init` to populate `.git/hooks`
  with real, non-sample hooks — which directly falsifies A1-EVID-012 ("no matched key and
  only sample hooks → `none-observed`") and A1-EVID-013. A global `core.hooksPath`,
  `include.path`, or `core.autocrlf` similarly perturbs fixtures. None of these appear in
  `--local`, so the production scan is unaffected — meaning the failure is a *test* that
  passes or fails depending on whose machine it runs on, in the one slice whose entire
  value is deterministic host-boundary proof. §16's own carve-outs for `user.name` and
  `--no-gpg-sign` show the author was thinking about exactly this class and stopped one
  step short.
- **Violated.** Process protocol §8 (deterministic verification); CT-04A exit gate.
- **Required plan change.** State that all fixture construction uses the same
  constructed-environment discipline as production — at minimum `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `LC_ALL=C` — and that
  fixture temp roots are `realpath`-resolved before use, since §11.2 rejects every symlink
  component and `os.tmpdir()` is not canonical on every platform.
- **Suggested adversarial case.** Run the Git-package suite with a synthetic `HOME`
  containing a `.gitconfig` that sets `init.templateDir`, `core.hooksPath`, and
  `include.path`, and assert the suite result is byte-identical to a run with an empty
  `HOME`.

### A1-F-07 — Medium — Test and fixture modules live inside the compiled package root, creating a second, scope-exempt, unbounded Git execution path in shipped output

- **Claim.** §5 predicts "one production authority file importing `node:child_process`" and
  §21 states "The only production child process is the private bounded local Git runner
  executing the three fixed read-only variants." But `test-support.ts` and the five
  `*.test.ts` modules live in `packages/git/src`, are compiled into `dist`, and will
  contain `git init`, `git commit`, `git worktree add`, `git init --separate-git-dir`, and
  `git config --worktree` — none of them members of `FixedGitCommand`, none bounded, and
  `git worktree add` is a CT-04C authority.
- **Evidence.** `packages/git/tsconfig.json` sets `"include": ["src"]` with no exclude, and
  the repository already demonstrates the consequence: `packages/planning/dist/aq-fixture.test.js`,
  `packages/testing/dist/fake-git-service.test.js`, `apps/server/dist/*.test.js`, and
  `packages/contracts/dist/*.test.d.ts` are all present in the working tree. "In `src`"
  already means "shipped in `dist`" repo-wide. Separately,
  `scripts/check-forbidden-scope.mjs` evaluates `if (isTestModule(path)) { return; }`
  **before** the capability loop, and `isTestModule` matches
  `/test-support\.[cm]?[jt]sx?$/` — unanchored to a path separator — so the fixture module
  is exempt from the very narrowing §3.3 introduces. A1-BND-004 ("scan production commands
  | exactly version, identity, local-feature names") has no stated definition of
  "production" that excludes it.
- **Violated.** CT04-I01; CT04-I16; the plan's own §21; process protocol §7 ("add
  next-slice behavior").
- **Required plan change (operator-selected remedy).** Move all A1 test and fixture
  modules **out of the compiled source root** rather than excluding them by manifest
  pattern. A pattern-based `exclude` is a per-file allowlist that the next fixture escapes
  silently; a structural boundary cannot be escaped by naming. Concretely, the accepted
  plan must specify all four consequences, because they are coupled:
  1. New location `packages/git/test/` holding the five `*.test.ts` modules and the
     fixture builders. `packages/git/src` then contains production modules only.
  2. `packages/git/tsconfig.json` keeps `"include": ["src"]` and `"rootDir": "src"`, so
     `dist` emits production modules only. Because `rootDir` is `src`, the test modules
     must move **with** the fixtures — a file under `src` importing a sibling directory
     outside `rootDir` is a `tsc` error, so a partial move does not build.
  3. Type-checking for `packages/git/test/**` needs an explicit home, since `tsc -b` will
     no longer see it. Add `packages/git/tsconfig.test.json` (`"noEmit": true`, rootDir at
     the package root, referencing the package) and extend the root `typecheck` script,
     which already has precedent for a second explicit invocation
     (`tsc -b && tsc --noEmit -p apps/web`).
  4. `vitest.config.ts`'s `node` project must gain `packages/*/test/**/*.test.ts`, or the
     moved tests are silently not collected — a green run proving nothing.
  5. `scripts/check-forbidden-scope.mjs` walks only `<packageDir>/src`. It must be extended
     to walk the new directory so the Exo Stack and NUL-byte rules still apply there, while
     continuing to allow wider capability in test modules. Without this, moving fixtures
     out of `src` also moves them out of scope enforcement entirely.

  The accepted plan must also state that A1 establishes this convention for
  `packages/git` only and records it in ADR-008 for future slices; retrofitting the other
  seven packages is out of A1 scope and must not be attempted here. Finally, define
  "production" for A1-BND-004 as "every module the package build emits", make the
  `node:child_process` scope narrowing an anchored allowlist of exactly one path rather
  than a filename regex, and state plainly that fixture Git commands are unbounded and
  inherit no production guarantees. §5's file tree and scope estimate must be updated for
  the moved paths and the three configuration files.
- **Suggested adversarial case.** A permanent test asserting the emitted `dist/` tree for
  `packages/git` contains no module importing `node:child_process` other than the single
  allowlisted runner, and contains no test or fixture module at all; a scope-checker test
  asserting that a file named `packages/storage/src/x-test-support.ts` importing
  `node:child_process` is **rejected**; and a vitest collection assertion that the moved
  test files are actually run.

### A1-F-08 — Medium — Bound arithmetic is not reconciled across limits, and the deadline's scope is unstated

- **Claim.** Three declared bounds cannot all hold simultaneously, and one declared
  acceptance expectation may be unreachable.
- **Evidence.** §7 accepts `stdoutLimitBytes` as low as **1024**, while §7 also bounds one
  UTF-8 path at **4096 bytes**. The identity command emits the top-level plus two copies of
  the Git directory: worst case ≈ 4096 + 4101 + 4101 + 3 newlines + ~16 bytes of tail ≈
  **12.3 KB**. A caller configuring near the floor gets systematic `stdout-overflow` on
  ordinary repositories — a configuration the plan explicitly accepts (A1-CFG-009: "exact
  min/max process limits | accepted"). Separately, §7 bounds observed config keys at 256
  while `stdoutLimitBytes` defaults to 65536; §10 states "Overflow and timeout take
  precedence over a later exit code", so with long subsection names the 256-key bound is
  reached only after overflow already fired — making A1-EVID-009's expected
  `feature-count-exceeded` dependent on key-name length rather than key count. Finally, §7
  gives one `timeoutMs` but §8.2 says identity and feature-scan "are each invoked once per
  inspection", and nothing states whether the deadline is per command or per `inspect()`;
  there is also no bound on the `lstat` component walk in §11.2 step 5 and no stated
  behaviour for a signal that is **already aborted** when `inspect()` is called.
- **Violated.** CT04-I16 ("bounded outputs and deadlines"); REG-GIT-005/006/007; the plan's
  own A1-CFG-009 and A1-EVID-009.
- **Required plan change.** Raise the `stdoutLimitBytes` floor to at least the computed
  worst-case identity output and show the arithmetic in the plan. State the
  overflow-vs-count precedence explicitly and pick the fixture (short key names) that makes
  `feature-count-exceeded` reachable, or drop the count bound in favour of the byte bound
  alone. State that `timeoutMs` is per Git invocation and add a separate stated bound on
  total `inspect()` wall time. Add the already-aborted-signal case to §14.3.
- **Suggested adversarial case.** A repository whose canonical top-level is close to 4096
  bytes, inspected at the minimum accepted `stdoutLimitBytes` and at the default; a feature
  fixture with 257 short keys and one with 200 very long keys, asserting the declared code
  in each; an `inspect()` call with a pre-aborted signal asserting `aborted` and **zero**
  spawns.

### A1-F-09 — Low — Detached process groups mean orphaned Git children are unbounded after daemon death, not "brief"

- **Claim.** §10 step 4 starts "a detached POSIX process group", and §10 says a hard daemon
  kill "can leave a read-only child alive briefly". The deadline is enforced by a
  parent-side timer. If the parent dies, nothing enforces it, and `detached` specifically
  prevents the child from receiving the parent's group signals.
- **Evidence.** §10 steps 4 and 7. The design is *correct* — detachment is what makes
  `kill(-pid)` reliable for a child that spawns its own children (A1-GIT-013) — but it
  trades away orphan reaping, and "briefly" is the only place that trade is described.
- **Violated.** Not a contract invariant; an honesty defect in a document CT-04C will
  inherit as its process-lifecycle precedent.
- **Required plan change.** Replace "briefly" with the actual property: A1 chooses reliable
  group termination over orphan reaping; a child outliving a hard daemon kill has no upper
  lifetime bound; this is acceptable in A1 because the child holds no lock, mutates
  nothing, and has closed stdin, but CT-04C must not assume a bounded child lifetime when
  it inherits this runner for `worktree add`.
- **Suggested adversarial case.** Not testable in-process without killing the runner; state
  it as a documented limitation with its reason, per the plan's own precedent for
  REG-GIT-004.

### A1-F-10 — Low — Git's upward repository discovery is constrained only by output comparison

- **Claim.** The constructed environment omits `GIT_CEILING_DIRECTORIES`, so `rev-parse`
  freely ascends out of the requested directory into an ancestor repository. Detection
  relies entirely on the template comparison — which works, but reports the wrong thing
  (A1-F-01).
- **Evidence.** Probe: from `outer/sub` (containing an empty `.git`), the planned command
  returns `outer` as the top-level, exit 0. Adding
  `GIT_CEILING_DIRECTORIES=<parent of request>` to the same command turns it into
  `fatal: not a git repository (or any of the parent directories): .git`, exit 128 — an
  unambiguous refusal at the source rather than a silent wrong answer caught downstream.
  Setting it to the request itself does *not* stop the ascent; the parent is the correct
  value.
- **Violated.** CT04-I16 — defence in depth rather than a violation.
- **Required plan change.** Add `GIT_CEILING_DIRECTORIES=<parent of the admitted canonical
  request>` to the identity and feature invocations as a per-invocation environment value,
  and state it as defence in depth that does not replace the template comparison. Note the
  one constraint: the value must itself be symlink-free, which §11.2 step 5 already
  guarantees.
- **Suggested adversarial case.** The nested-`.git` fixture from A1-F-01, asserting the
  command fails at the Git boundary rather than returning an ancestor's top-level, and that
  removing the ceiling variable still produces a rejection through the template path.

### A1-F-11 — Low — Executable resolution and the root-UID ownership case are underspecified

- **Claim.** Three small gaps in §7 and §11.3. (a) The precedence when both `gitExecutable`
  and `executableSearchPath` are supplied is unstated. (b) The `PATH` fallback reads "the
  caller process's current `PATH`", making the resolved binary a property of however the
  daemon was launched — a determinism hazard for a slice whose value is determinism, and
  one A2 inherits with no configuration knob. (c) §11.3 requires ownership by the daemon's
  **effective UID** and offers no `safe.directory` escape, but says nothing about a daemon
  running as root: under that policy such a daemon can register nothing at all, while Git
  itself has separate `SUDO_UID` handling.
- **Evidence.** §7 paragraphs 2–4; §11.3 paragraph 1; §16's ownership fixture explicitly
  skips "when the test runner is root", showing the case was considered for tests but not
  for policy.
- **Required plan change.** State that an explicit `gitExecutable` wins and that supplying
  both is accepted with the search path ignored, or rejected — either is fine, silence is
  not. State that A2 must pass an explicit `executableSearchPath` in production and that
  ambient `PATH` is a development convenience. State the root-daemon policy: refuse
  creation, or refuse every registration with a specific code, and record it in
  `docs/operations.md` next to the ownership refusal.
- **Suggested adversarial case.** Both options supplied; an `executableSearchPath` entry
  that is a symlink to a wrapper script; and, guarded on `process.getuid() === 0`, the
  declared root-daemon behaviour.

### A1-F-12 — Low — The protected gate depends on Git history being present in the working clone

- **Claim.** §17 and §19 put `git diff --exit-code 06abcffe… -- protected/` into the root
  `pnpm check` gate. That fails in a shallow clone, a `git archive` export, or any checkout
  that does not contain the pinned object — reporting a protected-package violation when
  none exists.
- **Evidence.** §17 ("The root gate adds…"), §19 ("`pnpm check` will include the
  protected-package command through `package.json`").
- **Required plan change.** Keep the `git diff` pin as a **release/merge** gate (protocol
  §12 evidence) and make the routine `pnpm check` step the filesystem hasher, which needs
  no history. Or keep both, but make the Git comparison detect a missing object and fail
  with a distinct, actionable message rather than a generic non-empty diff. State which.
- **Suggested adversarial case.** Run the gate in a `--depth=1` clone; assert the failure
  message names the missing pin rather than claiming the protected package changed.

### A1-F-13 — Info — Two smaller items

- §18 says `docs/architecture.md` will be "redrawn without duplicate server nodes". The
  duplicate was in the *unified plan's* §4 diagram (F-22); the repository's
  `docs/architecture.md` mentions `server` in two different blocks, legitimately — a
  package-role list and a project-reference graph. The accepted plan should not describe a
  repair to a defect that is not in the target file.
- §11.2's reject-every-symlink policy is the stricter branch of REG-PATH-011's "rejected
  **or** exact accepted policy result" and has no operator override. Verified on this host:
  `/home/keiths/src/craftingtable` has no symlink component and sits on ext4, so neither
  the symlink policy nor the `st_dev` concern blocks the CT-04E AQ-01 dogfood here. That is
  worth recording in `docs/operations.md` as the reason the strict branch was affordable,
  since a future operator on a different layout will hit it before any success case.

## Coverage gaps

The A1 matrices are genuinely strong: 12 configuration rows, 24 path rows, 20 process
rows, 21 evidence rows, 6 boundary rows, each written as an invariant rather than an
example, and §15 maps every parent REG-* case to a named A1 contribution plus an explicit
A2 obligation without claiming parent completion. The gaps below are rules the plan states
or implies and does not carry into the matrix.

- **Error-classification exhaustiveness** — §13 declares 24 codes; §14 names roughly half.
  No row asserts that every declared code is producible, and no compile-level guard stops a
  new code being added without a case (A1-F-02).
- **Recorded-observation validation** — no row anywhere for a malformed, truncated, or
  wrong-version stored observation (A1-F-03).
- **Concurrency** — nothing exercises two `inspect()` calls in flight on one inspector. The
  inspector holds shared mutable state (cached executable inode/size/mtime evidence,
  revalidated per invocation per §7), and A2 will memoize one instance across concurrent
  HTTP requests. Two concurrent inspections racing an executable replacement is the case.
- **Unreadable repository internals** — no row for `.git/config` or `.git/hooks` existing
  but unreadable (mode `000`), which is distinct from missing and from ownership refusal.
- **Unknown repository extension** — a repository with `core.repositoryFormatVersion=1` and
  an unrecognised `extensions.*` makes Git refuse with a fatal error; under the current
  spec that becomes an undifferentiated `git-command-failed` (related to A1-F-01).
- **Spawn-count assertion** — A1-BND-004 scans the command surface, but no row asserts one
  `inspect()` performs **exactly two** spawns. That is the cheapest guard against a later
  slice adding a third command without review, and the direct analogue of the "zero
  inspector calls" assertions A2 will need.
- **Deep-import resistance** — A1-GIT-020 checks the entry point's exports. Nothing asserts
  that `packages/git/package.json`'s `exports` map stays free of wildcards, which is what
  actually prevents A2 from reaching `dist/command-runner.js` directly (A1-F-07).
- **Fixture determinism** — no row proving the suite is invariant to the developer's global
  Git configuration (A1-F-06).
- **Crash windows** — correctly thin, and the plan is right to say so. Enumerated against
  the required checklist: *before durable intent* — none exists, A1 writes nothing;
  *process execution* — spawn failure and orphan survival (A1-F-09); *observation* — the
  step-13 postflight covers path/layout/inode replacement and honestly disclaims same-inode
  content edits; *state commit* — none; *notification* — none. A1-EVID-021 states the
  invariant. The one thing missing is a positive statement that A1 creates **no** file
  anywhere on the host, including temporary files, which would make the "no reconciliation
  hook" claim complete rather than repository-scoped.
- **Browser temporal identity** — correctly out of scope and correctly claimed: A1 adds no
  fetch, no event kind, no projection, and no `apps/web` file. Verified that the file tree
  contains no `apps/**` entry and the plan registers no workspace-event kind, so F-02's
  forced browser changes stay in A2 as the disposition requires.
- **Cross-workspace / same-workspace-wrong-parent / NULL dimensions / direct-storage
  attempts** — genuinely inapplicable; A1 has no workspace, no relationship, and no
  storage. The optional-dimension analogue *is* applicable and is partly covered
  (`gitExecutable?`, `timeoutMs?` and friends) and partly not (`signal?` already aborted;
  both executable options supplied — A1-F-08, A1-F-11). The direct-storage analogue is
  deep-import resistance, listed above.

## Scope assessment

27 files, one authority boundary (the local Git process), one runtime package, no schema,
no routes, no journal, no browser. Well under every split trigger in process protocol §4
and parent §5, and the plan states its own stop condition for re-splitting. **No further
decomposition is warranted.**

The A1/A2 seam holds under pressure. The critical structural property — that the daemon
does not gain a Git dependency — is real and its mechanics were verified:
`apps/server/package.json` depends on neither seam, `packages/testing` imports
`@craftingtable/git` with `import type` only, and the factory is lazy, so nothing loads
`node:child_process` at daemon start. §21's exclusions are accurate against the target
tree.

**CT-05+ leakage: one instance.** The requirement that artifact and managed-worktree roots
be strict descendants of the data root (A1-F-04) is a CT-04C/CT-04D configuration decision
made in the slice with the least information, and it is load-bearing in A1's own proof. The
forward-referential *presence* of those root names is not leakage — REG-PATH-009 and
REG-PATH-010 are CT-04A protected cases that cannot be satisfied without them, exactly as
the CT-04A review concluded. The fixture use of `git worktree add` is test-only in intent
but becomes a leakage question because of where the fixture module lives (A1-F-07).
Nothing else: no change request, branch, base resolution, diff, artifact, agent, check,
review, or merge behaviour appears anywhere in the plan.

**On the two self-reported corrections in §22.4.** Both are correct and both matter. The
lowercase canonicalization was reproduced (`git config --name-only --list` returns
`core.hookspath`, `extensions.worktreeconfig`, `diff.Custom.textconv` — section and key
lowercased, subsection case preserved), and the eight-alternative ERE was confirmed to
match all seven planted keys including `includeif.gitdir:/tmp/.path`. The newline-safe
raw-template comparison is the right answer to REG-PATH-012 and is strictly better than the
unified plan's line splitting. A1-F-01 asks the plan to add discrimination *on top of* that
comparison, not to replace it.

## Operator dispositions and required plan amendments

Adjudicated by the operator on 2026-07-26. All findings accepted. The reviewer's
recommendation was adopted on every decision except F-07, where the operator selected the
stronger structural remedy.

| Decision | Finding | Operator disposition |
|---|---|---|
| 1. Identity-failure discrimination | A1-F-01 | **Accepted as recommended.** Keep whole-output equality as the acceptance test; add tail-field classification on failure; correct the A1-PATH-016/017/019 expected values. |
| 2. Failure-classification axis for A2 | A1-F-02 | **Accepted as recommended.** Add the orthogonal disposition-class field with a complete code→class table. `retryability` alone is insufficient. |
| 3. Recorded-observation parse contract | A1-F-03 | **Accepted as recommended.** Export a total parser; define the version-mismatch rule; put both version numbers inside the fingerprint input. |
| 4. Reserved-root topology | A1-F-04 | **Accepted as recommended.** Replace the strict-descendant rule with pairwise non-overlap; do not require A2 to name CT-04C/D roots. |
| 5. Fixture-module placement | A1-F-07 | **Accepted with the operator's remedy, not the reviewer's.** Move test and fixture modules **outside the `src` root** rather than excluding them by manifest pattern. Rationale: a pattern-based exclude is a per-file allowlist that a future fixture escapes silently by not matching a pattern chosen today; a structural location boundary cannot be escaped by naming. This also establishes the location where future test fixtures belong in an application repository. |
| 6. Re-review before the accepted plan | — | **Accepted as recommended.** No second design review. Dispositions are recorded here; amendments land in `CT-04A1-accepted-implementation-plan.md`; the exact-head code review carries them. |

Findings A1-F-05, A1-F-06, A1-F-08 through A1-F-13 are accepted as written and are
implementer dispositions to be folded into the accepted plan.

### Binding amendment list for `CT-04A1-accepted-implementation-plan.md`

The accepted plan must reconcile each item below in a section-mapped appendix
(finding → disposition → accepted-plan section → proof cases), per disposition §8 Step 5.

1. **§8.2, §13, §14.2** — tail-field classification restoring `not-primary-repository`;
   `must be run in a work tree` diagnostic mapping; corrected A1-PATH-016/017/019
   expectations. (A1-F-01)
2. **§13, §20** — disposition-class field, complete code→class table, and the stated rule
   for a re-inspection that fails with no observation to compare. (A1-F-02)
3. **§6, §12.1, §12.3** — `parseRecordedObservation` export, version-mismatch rule,
   versioned fingerprint input. (A1-F-03)
4. **§7, §11.1** — pairwise non-overlap replacing strict-descendant; reserved roots as a
   list or optional fields. (A1-F-04)
5. **§8.2, §12.2** — scan-scope self-description, config-key exclusion list,
   `core.worktree` signal. (A1-F-05)
6. **§16** — constructed-environment discipline and `realpath`-resolved temp roots for
   fixtures. (A1-F-06)
7. **§3.3, §5, §21, §14.3, §14.5** — test and fixture modules relocated outside
   `packages/git/src`; `tsconfig.test.json` for type-checking the new location; vitest
   `node` project include extended; forbidden-scope walker extended to the new directory;
   anchored single-path `node:child_process` allowlist; "production" defined as emitted
   output; convention recorded in ADR-008 for `packages/git` only, with retrofitting the
   other packages explicitly out of A1 scope; §5 file tree and scope estimate updated.
   (A1-F-07)
8. **§7, §10, §14.3** — reconciled bound arithmetic with the stated worst case, declared
   overflow-vs-count precedence, per-invocation deadline plus a total-inspection bound,
   already-aborted-signal case. (A1-F-08)
9. **§10** — honest orphan-lifetime statement replacing "briefly", carried as a note into
   the CT-04C handoff. (A1-F-09)
10. **§9, §8.2** — `GIT_CEILING_DIRECTORIES` as per-invocation defence in depth.
    (A1-F-10)
11. **§7, §11.3, docs/operations.md** — executable-option precedence, explicit production
    search path, root-daemon ownership policy. (A1-F-11)
12. **§17, §19** — protected-gate split between the history-independent hasher and the
    pinned Git comparison. (A1-F-12)
13. **§18, docs/operations.md** — drop the non-existent architecture-diagram repair; record
    the symlink-policy operability consequence. (A1-F-13)
14. **§14** — add the coverage-gap rows: error-code exhaustiveness with a compile-level
    guard, recorded-observation validation, concurrent inspection, unreadable
    `.git/config` and `.git/hooks`, unknown repository extension, exact spawn-count
    assertion, `exports`-map wildcard assertion, fixture determinism under a hostile global
    config, and the positive "A1 creates no file anywhere on the host" statement.

The A1/A2 boundary, the 27-file-class scope judgement, the three-command production
surface, the constructed environment, and the split decision are **unchanged** by these
amendments. The file tree grows by the relocated test/fixture paths plus
`packages/git/tsconfig.test.json`, `vitest.config.ts`, and the forbidden-scope walker
change identified in amendment 7.

---

**Review metadata** (process protocol §13)

```text
reviewer role        independent pre-implementation design reviewer (CT-04A1, focused)
reviewer harness     Claude Code, Opus 5 (1M context), read-only session
plan reviewed        74685e1385970ef29165a7c5291d6de30bb7294a0ec0e043886e9088318b9aa0
source baseline      abc5f37815ad76430cae989224afde817d77a047
protected pin        06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4
review checkout      c42907b249578eca8ba51638543a069b8e0e880c
protected spec       ce7a101c…f090f64 (verified unchanged, diff clean against pin)
empirical probes     git 2.54.0; identity command, feature-scan command, constructed
                     env under `env -i`, nested-.git ascent, core.bare, core.worktree,
                     linked worktree, sha256 repo, GIT_CEILING_DIRECTORIES,
                     emitted-dist inspection across all packages
findings             0 blocking, 3 high, 5 medium, 4 low, 1 info
verdict              PASS WITH ACCEPTED AMENDMENTS
disposition          all findings accepted; F-07 resolved with the operator's
                     structural remedy (fixtures outside the compiled source root)
```
