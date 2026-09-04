# CT-04A1 Initial Implementation Report

**Work item:** CT-04A1 — Trusted Git inspection boundary
**Parent:** CT-04A — Trusted Git boundary and repository registration
**Accepted plan:** `work-items/CT-04/CT-04A1-accepted-implementation-plan.md`
**Planning commit:** `415d2775eede7fcf353c47d17be068b3fc28fe04`
**Implementation base:** `415d2775eede7fcf353c47d17be068b3fc28fe04`
**Implementation head for independent review:** `acc5cb685a7ed9ff1d1cdadac3df6f9ec30ce2c8`
**Protected-package pin:** `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
**Status:** initial implementation complete; deterministic and real-Git gates pass;
awaiting independent review

## Initial-review erratum

Independent review of the immutable initial head found that the final
exit-zero strict-ancestor identity branch inverted its classification:
well-framed ancestor output was reported as `malformed-identity-output` rather
than `not-primary-repository`. The initial report's broad repository-class
claim below was therefore too strong for that branch. The initial review also
confirmed that postflight compares size and mtime, so ordinary top-level
working-tree entry changes can produce `observation-raced`; it is not limited
to inode or layout replacement. Both facts are carried into the remediation
record, while this report continues to describe the immutable initial head.

## 1. Summary

CT-04A1 adds one real but uncomposed local Git authority to
`@craftingtable/git`. An explicitly configured inspector accepts an untrusted
host path and returns either a versioned, runtime-validated repository
observation or a bounded typed failure.

The implementation is observation only:

```text
explicit source/reserved/executable policy
  → canonical path and ownership admission
  → fixed identity command
  → fixed local risk-signal-name command
  → postflight replacement check
  → parsed observation or typed observational failure
```

No repository is registered, assigned an ID, stored, bound to a project,
journaled, exposed by HTTP, or projected into the browser. The daemon still
does not import `@craftingtable/git`.

The implementation commit contains exactly the accepted 29 changed/new files:
4,647 insertions and 50 deletions. It is one commit after the committed
planning/review phase.

## 2. Public and private boundary

The public package entry point preserves CT-01's simulated `GitService` and
adds:

- lazy `createRepositoryInspector`;
- `RepositoryInspector.inspect`;
- total `parseRecordedObservation`;
- branded `ParsedRepositoryObservation`;
- `compareRepositoryObservations`;
- closed error, subject, risk-signal, and version vocabularies.

The public entry point exports no argv, environment, raw runner, spawn
function, or arbitrary command carrier. `packages/git/package.json` remains an
exact `"."`-only export map with no wildcard or deep export.

The sole production process import is:

```text
packages/git/src/command-runner.ts → node:child_process
```

The extended scope gate rejects that import in every other production file,
walks structural package test directories, and rejects filename-based
`test-support` authority escapes.

## 3. Exact Git command and environment policy

The executable is resolved lazily during explicit inspector creation. An
explicit executable wins over a supplied search path. Production A2 must
supply an explicit executable or explicit absolute search path; ambient
`PATH` remains a development/test convenience. The canonical executable's
path, inode, size, mtime, and device evidence is recorded. Path, inode, size,
or mtime replacement prevents another spawn; a device-only change is not
treated as binary replacement.

Git 2.32.0 is the minimum. Vendor suffixes are accepted after a valid leading
version tuple. POSIX and a non-root effective UID are required.

The closed production command variants are:

```text
<canonical-git> --version

<canonical-git> -c core.fsmonitor=false rev-parse \
  --path-format=absolute \
  --show-toplevel \
  --absolute-git-dir \
  --git-common-dir \
  --is-bare-repository \
  --is-inside-work-tree \
  --show-object-format=storage

<canonical-git> -c core.fsmonitor=false config \
  --local \
  --no-includes \
  --null \
  --name-only \
  --get-regexp \
  '^(extensions\.worktreeconfig|core\.(hookspath|fsmonitor|worktree)|diff\.external|diff\..*\.(command|textconv)|filter\..*\.(clean|smudge|process)|include\.path|includeif\..*\.path)$'
```

Every child receives a newly constructed base environment containing exactly:

```text
LC_ALL=C
LANG=C
GIT_TERMINAL_PROMPT=0
GIT_PAGER=cat
PAGER=cat
GIT_OPTIONAL_LOCKS=0
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_SYSTEM=/dev/null
GIT_CONFIG_GLOBAL=/dev/null
GIT_ATTR_NOSYSTEM=1
```

Repository commands add only:

```text
GIT_CEILING_DIRECTORIES=<canonical parent of admitted request>
```

There is no inherited `HOME`, `PATH`, Git directory/worktree/index/object
override, askpass, SSH, credential, proxy, or trace variable. Spawns use
argument arrays, `shell: false`, closed stdin, and detached POSIX process
groups.

Stdout and stderr are counted independently. Timeout, abort, overflow, spawn
failure, signal termination, and ordinary nonzero exits remain distinct.
Timeout/abort/overflow sends group TERM, waits the bounded grace interval, then
sends group KILL. Partial output never succeeds.

## 4. Path, ownership, and repository policy

Source roots are required, canonical, existing, symlink-free directories.
Reserved roots are optional and may be nonexistent, but every existing
component must be canonical and symlink-free. Source roots and reserved roots
are pairwise non-overlapping in both ancestor directions.

A repository request must:

- be an absolute normalized UTF-8 path of 1–4096 bytes with no NUL;
- be strictly below exactly one source root;
- remain outside every reserved root;
- contain no symlink component;
- resolve exactly as written to an existing directory;
- be an exact primary checkout with a real `.git` directory;
- have readable repository metadata;
- be owned, with its common Git directory, by the non-root daemon effective
  UID.

Bare repositories, ordinary subdirectories, linked worktrees, submodule
checkout files, separate Git directories, `commondir`, redirected worktrees,
and unsupported repository extensions were intended to be rejected with
repository-class failures rather than parse-corruption failures. At the
initial reviewed head, the exit-zero strict-ancestor branch violated that
intent as described in the erratum.

Whole identity stdout must equal the expected raw bytes for success. This
supports spaces, leading dashes, metacharacters, tabs, and embedded newlines in
paths. On mismatch, only the three path-free tail fields are peeled for honest
classification. A postflight lstat/stat/realpath comparison fails with
`observation-raced` when kind, device, inode, size, mtime, or canonical
resolution evidence changes.

Production inspection creates no temporary file, directory, lock, marker,
log, or repository state anywhere on the host.

## 5. Observation and failure contracts

Observations include:

- observation and inspection-policy versions;
- exact canonical top, Git, and common Git paths;
- Git version and `sha1`/`sha256` object format;
- decimal inode and device evidence;
- a SHA-256 core fingerprint whose length-prefixed input begins with both
  version numbers;
- a timestamp;
- self-describing risk scan scope, classification, and sorted unique signals.

The scan reads local config names only and no config value. Hook enumeration
records only a generic non-sample entry or hooks-directory-symlink signal; it
does not read hook content. `no-signals-in-scanned-set` is deliberately not a
claim that the repository is safe for mutation.

`parseRecordedObservation(unknown)` rejects unknown fields, malformed
structures, noncanonical numeric strings, unknown observation versions,
altered fingerprints, invalid timestamps, and unsorted/unknown risk signals.
It is total and does not throw for hostile input. Comparison accepts only
branded parsed observations and returns a distinct
`inspection-policy-version-mismatch` outcome rather than equality under
different scan policies.

Every public error carries:

```text
category · code · subject · operation · retryability · fixed message
bounded allowlisted evidence
```

The complete code-to-subject map is compile-time checked and asserted by exact
set equality in tests. Raw stdout, stderr, environment, config names/values,
paths, credentials, and arbitrary system diagnostics do not cross the public
failure boundary.

## 6. Files changed by boundary

### Runtime Git boundary

```text
packages/git/src/index.ts
packages/git/src/types.ts
packages/git/src/configuration.ts
packages/git/src/environment.ts
packages/git/src/command-runner.ts
packages/git/src/path-policy.ts
packages/git/src/repository-inspector.ts
packages/git/src/comparison.ts
```

### Structural tests and fixtures

```text
packages/git/tsconfig.test.json
packages/git/test/test-support.ts
packages/git/test/configuration.test.ts
packages/git/test/command-runner.test.ts
packages/git/test/path-policy.test.ts
packages/git/test/repository-inspector.test.ts
packages/git/test/comparison.test.ts
```

### Quality and protected-package gates

```text
package.json
vitest.config.ts
scripts/check-forbidden-scope.mjs
scripts/check-forbidden-scope.test.mjs
scripts/check-ct04-protected-package.mjs
scripts/check-ct04-protected-package.test.mjs
```

### Documentation and ADRs

```text
README.md
CLAUDE.md
docs/architecture.md
docs/security.md
docs/operations.md
docs/decisions/README.md
docs/decisions/ADR-008-toolchain-and-quality-gates.md
docs/decisions/ADR-016-trusted-local-git-inspection-boundary.md
```

`packages/git/package.json`, `packages/git/tsconfig.json`, `pnpm-lock.yaml`,
all schema/migration files, server/domain/contracts/storage/browser source,
and every protected file are unchanged.

## 7. Permanent proof mapping

| Accepted proof family | Primary permanent location |
| --- | --- |
| A1-CFG-001–014 | `packages/git/test/configuration.test.ts`; process replacement cases in `command-runner.test.ts` |
| A1-PATH-001–028 | `packages/git/test/path-policy.test.ts`; real repository classes in `repository-inspector.test.ts`; output discrimination in `command-runner.test.ts` |
| A1-GIT-001–023 | `packages/git/test/command-runner.test.ts`; exact two-spawn and total-budget cases in `repository-inspector.test.ts`; scope/export cases in configuration and script tests |
| A1-EVID-001–024 | `packages/git/test/repository-inspector.test.ts`, `comparison.test.ts`, and parser fault cases in `command-runner.test.ts` |
| A1-BND-001–011 | Git configuration/repository tests, both scope-checker tests, protected-package tests, emitted-dist inspection, full gate, and this diff inventory |

Parent REG-PATH, REG-ID, and REG-GIT cases receive only the A1 observational
contributions mapped in the accepted plan. OWN-REP, JRN-REP, A-API, A-MIG,
A-NOTIFY, A-ROLE, and durable registration semantics remain A2.

## 8. Commands actually run

### Stable commits

| Command | Result |
| --- | --- |
| `git add <four planning/review artifacts>` | first sandboxed attempt failed because `.git/index.lock` was read-only; approved escalated retry passed |
| `git commit -m "CT-04A1 implementation planning phase"` | passed; `415d2775eede7fcf353c47d17be068b3fc28fe04` |
| `git add <exact 29 implementation files>` | passed after final verification |
| `git diff --cached --check` | passed |
| `git diff --cached --name-only \| wc -l` | `29` |
| `git commit -m "Implement CT-04A1 trusted Git inspection boundary"` | passed; `acc5cb685a7ed9ff1d1cdadac3df6f9ec30ce2c8` |

### Dependency/bootstrap

| Command | Result |
| --- | --- |
| `corepack pnpm install --frozen-lockfile` | attempted; failed before pnpm because `corepack` is unavailable (`command not found`) |
| `pnpm install --frozen-lockfile` | exit 0; lockfile already current; emitted a nonfatal registry metadata lookup warning because network name resolution was unavailable |

No dependency or lockfile changed.

### Focused implementation verification

| Command | Result |
| --- | --- |
| `pnpm exec biome format --write ...` | passed; formatted the changed TypeScript/JSON/MJS files |
| `pnpm exec biome lint packages/git ...` | final pass, no diagnostics |
| `pnpm exec tsc -b packages/git` | passed |
| `pnpm exec tsc --noEmit -p packages/git/tsconfig.test.json` | passed |
| `pnpm exec vitest run packages/git/test` | final pass: 5 files, 53 tests |
| `pnpm exec vitest run scripts/check-forbidden-scope.test.mjs scripts/check-ct04-protected-package.test.mjs` | pass: 2 files, 20 tests |
| `node scripts/check-forbidden-scope.mjs` | passed; exactly one reviewed production process authority |
| `node scripts/check-ct04-protected-package.mjs` | passed; exact two-file manifest and hashes |
| `find packages/git/dist -type f -print` | production modules only; no test/fixture output |
| `rg -l "node:child_process" packages/git/src` | only `packages/git/src/command-runner.ts` |
| server/storage/domain/contracts/browser Git-import and diff probes | no output; no A2 or browser change |

The dynamic executable proxies required by the accepted process tests are
blocked by the normal tool sandbox with `EPERM`. Focused and full runs that
exercise those proxies were therefore rerun with explicit approval outside the
sandbox.

### Full deterministic gate

`pnpm check` was run twice after the implementation had converged. Both runs
exited 0. The final exact-source run reported:

```text
format             208 files, no changes
lint               209 files, no diagnostics
typecheck          production, web, and Git structural tests passed
build              TypeScript workspace and Vite production build passed
unit/integration   60 files, 465 tests passed
Playwright         4 tests passed
scope              passed
protected package  passed
```

### Protected and final inventory

| Command | Result |
| --- | --- |
| `git cat-file -e '06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4^{commit}'` | passed |
| `git diff --exit-code 06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4 -- protected/` | passed; no diff |
| `sha256sum protected/README.md protected/CT-04-protected-acceptance-spec.yaml` | `4e857aca…` and `ce7a101c…`, matching the accepted plan |
| `git diff --check` | passed |
| trailing-whitespace `rg` scan over all 29 target files | no matches |
| `git status --porcelain=v1 --untracked-files=all \| wc -l` before implementation commit | `29` |
| temporary `.ct04a-*` directory probe | no leftovers |

Read-only reconciliation also used `rg --files`, `rg`, `sed`, `wc`, `find`,
`sha256sum`, and `git status`, `diff`, `log`, `show`, `rev-parse`,
`merge-base`, and `cat-file` probes. These confirmed the source seams, exact
file inventory, ancestry, emitted tree, protected state, and absence of
next-slice imports.

### Intermediate failures resolved before the reviewed head

- The first structural-test typecheck exposed six test-only cast/effective-UID
  errors; all were corrected and the final typecheck passed.
- Sandboxed proxy runs returned `EPERM`; approved outside-sandbox runs
  distinguished that environment restriction from implementation failures.
- The first outside-sandbox spawn-count proxy used CommonJS inside the
  repository's ESM scope; it was changed to an ESM proxy and the exact
  one-version-plus-two-inspection-spawn proof passed.
- Extending the structural test rule initially exposed the repository's
  existing exact test-support modules. The scope checker now allowlists those
  existing paths exactly while permanently rejecting
  `packages/storage/src/x-test-support.ts`.
- One focused lint run found an unused catch binding; it was removed.
- One early scope-check run failed on that exact legacy-test-support issue; the
  final script tests and full gate pass.

No protected check failed, and no failing intermediate state was committed as
the implementation head.

## 9. Protected-package evidence

The implementation did not edit `protected/`.

```text
protected/README.md
  4e857aca74d4c96f869a2f30e73f0aeb0153f8de2c0e77f972fea325647119fd

protected/CT-04-protected-acceptance-spec.yaml
  ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
```

Routine `pnpm check` uses the history-independent literal manifest/hash
verifier. Exact-head/release evidence separately proves the protected-package
pin exists and that `protected/` is byte-identical to it. Scratch negative
tests alter an expected outcome and add an extra file; both are rejected.

## 10. Known limitations

- Only non-root POSIX operation with Git 2.32.0 or newer is supported.
- The total inspection budget is cooperative around kernel-blocked filesystem
  syscalls; Node cannot preempt such a syscall.
- Detached groups bound descendants while the parent lives. A hard daemon
  death has no bounded orphan-lifetime guarantee.
- The no-symlink policy intentionally rejects otherwise usable symlinked source
  layouts.
- The trust boundary excludes root, mount administrators, and a malicious
  concurrent local owner.
- Postflight detects path/layout/inode and ordinary metadata replacement,
  including top-level directory-entry changes; it does not detect every
  possible same-inode content edit.
- Risk evidence describes only the literal scanned config-name set and generic
  hook presence. It is not approval for checkout or mutation.
- A1 is uncomposed. There is no operator-facing Git/source-root configuration
  yet.

## 11. Explicit CT-04A2+ scope check

CT-04A1 creates no:

- schema, migration 0003, SQLite row, repository ID/state/policy, inspection
  record, project binding, or uniqueness rule;
- HTTP/SSE contract, route, service, authorization response, audit action,
  event kind, transaction, notifier call, or browser behavior;
- change request, target ref, branch, checkout, commit, worktree mutation,
  status, diff, artifact store, agent, verification runner, review,
  remediation, readiness, merge, remote Git, credential-helper, or hosted
  provider behavior;
- arbitrary command, public argv/environment carrier, shell execution, or
  second production child-process authority.

The implementation head is ready for independent review at:

```text
acc5cb685a7ed9ff1d1cdadac3df6f9ec30ce2c8
```
