# CT-04A1 accepted implementation plan

Status: accepted design; implementation remains unauthorized until operator approval and
commit of this plan

Scope: CT-04A1 — Trusted Git inspection boundary

Source baseline:
`abc5f37815ad76430cae989224afde817d77a047`

Planning/review checkout:
`c42907b249578eca8ba51638543a069b8e0e880c`

Protected-package pin:
`06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`

Protected acceptance SHA-256:
`ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`

Reviewed proposal:
`work-items/CT-04/CT-04A1-proposed-implementation-plan.md`,
SHA-256 `74685e1385970ef29165a7c5291d6de30bb7294a0ec0e043886e9088318b9aa0`

Independent design review:
`review-findings/CT-04/CT-04A1-design-review.md`,
SHA-256 `c329b2741eb17c78c78523e582381c964d463bfc820f0c01d96f9e7817281e35`

Operator disposition:
`work-items/CT-04/CT-04A1-review-disposition.md`,
SHA-256 `333fdfca929d8cb2b8d56d463662d457b8b8cf7a31570d9f2db4882418d550b5`

## 1. Authorization and implementation stop

The focused design review passed with thirteen accepted amendments. This plan reconciles
all of them. It is the complete implementation contract for A1, but its creation does not
authorize code changes.

The required next sequence is:

```text
operator reviews this accepted plan
operator approves and commits it
only then implementation begins
```

The unified CT-04A proposal remains rejected. The adopted split is unchanged:

```text
CT-04A1  trusted Git/filesystem observation only
CT-04A2  authorized durable repository registry and project binding
```

A1 accepts an untrusted requested path and explicit programmatic inspection policy. It
returns a bounded, runtime-validated observation or a bounded, typed observational failure.
It does not authorize, persist, journal, or assign durable application state.

## 2. Source and protected-package reconciliation

The reviewed checkout descends from both the source baseline and protected-package pin:

```text
abc5f37  accepted CT-03 merge and source baseline
06abcff  protected CT-04 package introduced
b6eda1d  unified CT-04A review adjudication and A1/A2 split
c42907b  planning/implementation feedback-loop learnings
```

The commits after `06abcff` add planning/review/process artifacts only. Runtime source under
`apps/`, `packages/`, `scripts/`, `docs/`, the root manifests, README, and CLAUDE remains
the exact source inspected for the A1 proposal and review.

The two pins have distinct purposes:

- `abc5f37…` reconciles runtime source;
- `06abcff…` proves protected-package immutability at release/merge.

The protected directory contains exactly:

```text
protected/README.md
4e857aca74d4c96f869a2f30e73f0aeb0153f8de2c0e77f972fea325647119fd

protected/CT-04-protected-acceptance-spec.yaml
ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
```

The source assessment's statement that the baseline README called CT-02 current is stale.
The README at the baseline and review checkout says CT-03. The assessment remains
historical evidence; documentation updates use the verified source.

Two implementer corrections from the proposal remain binding:

1. `git config --name-only` emits lowercase section/key components such as
   `core.hookspath` and `extensions.worktreeconfig`; the scan regex uses those canonical
   spellings.
2. Identity output containing newline-bearing paths is validated by raw bytes, never by
   naïve line splitting.

## 3. Exact current seams and dependency direction

### 3.1 Current seams

- `packages/git/src/index.ts` contains only the CT-01 simulated `RepositorySnapshot` and
  `GitService`.
- `packages/testing` imports those legacy types with `import type`; its fake remains
  unchanged.
- `apps/server` does not depend on or import `@craftingtable/git`.
- `packages/git/package.json` and its production TypeScript project already have every
  runtime type/dependency needed by A1.
- Vitest currently collects package tests only under `src`; A1 deliberately establishes a
  new test location for the Git package.
- The scope checker currently rejects all production `node:child_process` imports and
  walks only package `src` directories.

### 3.2 Accepted direction

```text
@craftingtable/domain
          ↑
@craftingtable/git ──→ Node filesystem/process/crypto primitives
          ↑
@craftingtable/testing (legacy type-only/fake consumer)

@craftingtable/server ──→ domain + contracts + planning + storage
                         (no Git import in A1)
```

Within Git:

```text
explicit programmatic options
        ↓
configuration/root/executable validation
        ↓
RepositoryInspector (only exported authority interface)
        ↓
path policy + fixed command selection
        ↓
private bounded command runner
        ↓
parsed observation or typed observational failure
```

`@craftingtable/git` imports no Fastify, HTTP contracts, SQLite/storage, workspace/user/role
types, audit/event vocabulary, React, or testing fixture. A1 adds no server call site.

“Production” in this plan means every module emitted by the `packages/git` production
TypeScript build. The build emits `src` only. Test and fixture modules live outside `src`,
are typechecked separately, and never appear in `dist`.

## 4. Exact target file tree and scope estimate

Files marked `+` are new; `~` are modified.

```text
~ README.md
~ CLAUDE.md
~ package.json
~ vitest.config.ts

~ scripts/check-forbidden-scope.mjs
~ scripts/check-forbidden-scope.test.mjs
+ scripts/check-ct04-protected-package.mjs
+ scripts/check-ct04-protected-package.test.mjs

~ docs/architecture.md
~ docs/security.md
~ docs/operations.md
~ docs/decisions/README.md
~ docs/decisions/ADR-008-toolchain-and-quality-gates.md
+ docs/decisions/ADR-016-trusted-local-git-inspection-boundary.md

+ packages/git/tsconfig.test.json
~ packages/git/src/index.ts
+ packages/git/src/types.ts
+ packages/git/src/configuration.ts
+ packages/git/src/environment.ts
+ packages/git/src/command-runner.ts
+ packages/git/src/path-policy.ts
+ packages/git/src/repository-inspector.ts
+ packages/git/src/comparison.ts
+ packages/git/test/test-support.ts
+ packages/git/test/configuration.test.ts
+ packages/git/test/command-runner.test.ts
+ packages/git/test/path-policy.test.ts
+ packages/git/test/repository-inspector.test.ts
+ packages/git/test/comparison.test.ts
```

Corrected estimate:

```text
29 changed/new files
approximately 3,200–4,800 lines including tests and documentation
one production authority file importing node:child_process
one runtime package
no server, domain, contract, storage, migration, or browser layer
```

This is below the process split threshold and remains one independently reviewable
authority. No further decomposition is warranted. Stop and re-split if implementation
requires server activation, a second production process runner, durable state, browser
behavior, more than roughly 45 files, or a second assurance domain.

Files explicitly unchanged:

- `packages/git/package.json`: its export map remains only `"."`, with no wildcard/deep
  export.
- `packages/git/tsconfig.json`: retains `rootDir: "src"` and `include: ["src"]`.
- `pnpm-lock.yaml`: no dependency is added.
- all other packages' test/build layouts: A1 establishes the structural convention for
  `packages/git` only and does not retrofit the other packages.

## 5. Public observational API and runtime parse boundary

The entry point retains the legacy CT-01 simulated types and adds:

```ts
interface RepositoryInspector {
  inspect(request: RepositoryInspectionRequest): Promise<RepositoryInspectionResult>;
}

interface RepositoryInspectionRequest {
  readonly requestedPath: string;
  readonly signal?: AbortSignal;
}

type RepositoryInspectionResult =
  | { readonly ok: true; readonly observation: ParsedRepositoryObservation }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

async function createRepositoryInspector(
  options: RepositoryInspectorOptions,
): Promise<RepositoryInspectorCreationResult>;

function parseRecordedObservation(value: unknown): RecordedObservationResult;

function compareRepositoryObservations(
  recorded: ParsedRepositoryObservation,
  current: ParsedRepositoryObservation,
): RepositoryObservationComparisonResult;
```

`ParsedRepositoryObservation` is nominal/branded. Only a successful live inspection or
`parseRecordedObservation` can produce it. A2 cannot cast deserialized JSON directly into
the comparison input without an explicit unsafe escape that code review can detect.

`parseRecordedObservation` is total:

- accepts `unknown`;
- strictly validates every object, array, enum, timestamp, digest, bounded string, sorted
  unique signal, and unsigned-decimal filesystem value;
- rejects unknown fields;
- recomputes and verifies the core fingerprint;
- returns data, never throws, for hostile or malformed input.

Version behavior:

- `observationVersion` must equal `1`; missing, lower, higher, noninteger, or unknown
  versions return `unsupported-observation-version` or
  `recorded-observation-invalid`;
- a positive integer `inspectionPolicyVersion` is parseable under observation version 1;
- comparison requires equal inspection-policy versions;
- different inspection-policy versions return the distinct typed outcome
  `inspection-policy-version-mismatch`, with no `sameCoreIdentity` or
  `sameExternalExecutionEvidence` booleans;
- feature evidence collected under different scan policies is never called equal.

The versioned fingerprint input begins with both version numbers, followed by
length-prefixed fields:

```text
observationVersion
inspectionPolicyVersion
canonical top-level
canonical common Git directory
object format
top-level inode
common-directory inode
```

Private package-only interfaces:

```ts
type FixedGitCommand =
  | { readonly kind: 'version'; readonly cwd: CanonicalPath }
  | {
      readonly kind: 'identity';
      readonly cwd: CanonicalPath;
      readonly expectedTopLevel: CanonicalPath;
      readonly expectedGitDirectory: CanonicalPath;
    }
  | { readonly kind: 'local-risk-signal-names'; readonly cwd: CanonicalPath };

interface BoundedCommandRunner {
  run(command: FixedGitCommand, signal?: AbortSignal): Promise<PrivateCommandResult>;
}
```

There is no public `run`, `spawn`, command, argv, environment, or invocation carrier.

## 6. Programmatic configuration, executable policy, and reconciled bounds

```ts
interface RepositoryInspectorOptions {
  readonly allowedSourceRoots: readonly string[];
  readonly reservedRoots?: readonly string[];
  readonly gitExecutable?: string;
  readonly executableSearchPath?: string;
  readonly commandTimeoutMs?: number;
  readonly inspectionTimeoutMs?: number;
  readonly stdoutLimitBytes?: number;
  readonly stderrLimitBytes?: number;
  readonly terminationGraceMs?: number;
}
```

A1 parses no `CRAFTINGTABLE_*` environment variable. A2 owns lazy operator-facing feature
configuration.

### 6.1 Bounds

| Option/evidence | Default | Accepted range/rule |
| --- | ---: | ---: |
| source roots | required | 1–32 |
| reserved roots | empty | 0–32 |
| one UTF-8 path | n/a | 1–4096 bytes, no NUL |
| `commandTimeoutMs` | 5000 | 100–30000, per Git invocation |
| `inspectionTimeoutMs` | `2 × commandTimeoutMs + 5000` | 1000–90000 and at least `2 × commandTimeoutMs` |
| `stdoutLimitBytes` | 65536 | 16384–1048576 |
| `stderrLimitBytes` | 65536 | 1024–1048576 |
| `terminationGraceMs` | 250 | 50–2000 |
| scanned config keys | n/a | at most 256 complete NUL records |
| observed hook entries | n/a | at most 256 |

The stdout floor follows the identity worst case. For path byte length `P ≤ 4096`, Git
emits top-level once, `<top>/.git` twice, three path newlines, and at most the SHA-256
tail:

```text
P + 2(P + 5) + 3 + 17 = 3P + 30 ≤ 12318 bytes
```

The accepted 16384-byte floor leaves framing margin and makes every accepted path
representable.

Byte overflow takes precedence over semantic record-count parsing. The permanent
257-key count test uses short keys and stays below 16384, so it reaches
`feature-count-exceeded`. A separate 200-key fixture with long subsection names exceeds
the byte bound first and must produce `stdout-overflow`.

`commandTimeoutMs` applies independently to identity and feature scan. The total
inspection budget starts before path admission and prevents another operation/spawn after
expiry. It is checked before and after every filesystem step and supplied to both process
calls through one outer abort source. Node cannot preempt a kernel-blocked `lstat` or
`realpath`; the total bound is therefore cooperative around filesystem syscalls and hard
for child-process lifetime while the parent remains alive. That limitation is explicit.

An already-aborted request returns `aborted` before filesystem access and with zero
spawns.

### 6.2 Lazy executable resolution

Importing the module does no lookup or spawn. The explicit factory performs validation.

Precedence:

- if `gitExecutable` is supplied, it wins;
- supplying `executableSearchPath` as well is accepted but the search path is ignored;
- an explicit executable must be absolute, normalized, regular, executable, and
  `realpath`-canonicalized;
- if no executable is supplied, only absolute entries from `executableSearchPath` are
  searched;
- ambient process `PATH` is allowed only as a development/test convenience when neither
  option is supplied;
- A2 production configuration must pass either an explicit executable or an explicit
  search path; it may not rely on ambient daemon `PATH`.

An executable-search entry that is a symlink is canonicalized to its target and accepted
only if that target is a regular executable whose version probe passes. The canonical
absolute executable is stored; children receive no `PATH`.

The factory records canonical path, inode, size, mtime, and device evidence. Every later
invocation revalidates it. Path/inode/size/mtime change is
`git-executable-changed`; a device-only delta is environmental evidence and not by itself
a binary replacement.

A1 supports a non-root POSIX daemon only. If effective UID is 0, inspector creation returns
`root-daemon-refused`. A1 does not use Git's `SUDO_UID` exception or offer
`safe.directory`. This avoids making root-owned host authority an accidental supported
mode.

The version probe uses the first canonical source root as `cwd`, never an inherited daemon
current directory.

## 7. Git version and exact production command surface

### 7.1 Version

The parser accepts leading:

```text
git version <major>.<minor>[.<patch>]
```

and ignores legitimate trailing vendor content. Plain, Apple, and Windows-style forms are
required. Empty, non-Git, overflow, 1.x, and 2.31.x forms fail.

Minimum Git is 2.32.0:

- 2.29 introduced `--show-object-format`;
- 2.31 introduced `--path-format=absolute`;
- 2.32 introduced `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`.

The 2.32 environment behavior is the binding floor. Missing `HOME` is defense in depth.

### 7.2 Exact variants

Version:

```text
<canonical-git> --version
```

Identity, `cwd` equal to the admitted path:

```text
<canonical-git> -c core.fsmonitor=false rev-parse \
  --path-format=absolute \
  --show-toplevel \
  --absolute-git-dir \
  --git-common-dir \
  --is-bare-repository \
  --is-inside-work-tree \
  --show-object-format=storage
```

Local risk-signal names:

```text
<canonical-git> -c core.fsmonitor=false config \
  --local \
  --no-includes \
  --null \
  --name-only \
  --get-regexp \
  '^(extensions\.worktreeconfig|core\.(hookspath|fsmonitor|worktree)|diff\.external|diff\..*\.(command|textconv)|filter\..*\.(clean|smudge|process)|include\.path|includeif\..*\.path)$'
```

Version runs once at inspector creation. A successful `inspect()` performs exactly two
spawns: identity once and risk-signal scan once. No third command is permitted without a
new reviewed command-policy change.

For the risk-signal command only, exit 1 with both streams empty is Git's documented
no-match result and produces `no-signals-in-scanned-set`. Exit 1 with any output, or any
other nonzero exit, is a typed failure and can never produce empty evidence.

No production command performs status, diff, object lookup, ref lookup, remote access,
branching, checkout, commit, worktree mutation, hooks, filters, textconv, or arbitrary
execution.

## 8. Constructed environment, discovery ceiling, and process lifecycle

### 8.1 Base child environment

Every child receives a newly constructed base object containing exactly:

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

The implementation never clones/scrubs `process.env`. It therefore omits `HOME`, `PATH`,
Git directory/worktree/index/object/config overrides, askpass/SSH/credential/proxy
variables, and tracing.

For identity and risk-signal commands only, the runner adds:

```text
GIT_CEILING_DIRECTORIES=<canonical parent of admitted request>
```

That parent is already proven absolute and symlink-free. The ceiling prevents Git from
discovering an ancestor repository. It is defense in depth and does not replace raw output
comparison. Version receives only the ten base fields.

### 8.2 Process lifecycle

The private runner:

1. validates the closed command variant;
2. revalidates the executable;
3. constructs fixed argv and environment;
4. spawns directly with `shell: false`, closed stdin, separate stdout/stderr, and a
   detached POSIX process group;
5. counts both streams independently before concatenation;
6. settles exactly once;
7. on abort, overflow, or timeout sends group `SIGTERM`, waits the grace interval, then
   sends `SIGKILL`;
8. awaits close before returning;
9. discards partial output on every non-success.

Timeout, abort, independent overflow, spawn failure, signal, and ordinary nonzero exit are
distinct. Overflow/timeout dominates a later close. Raw output never crosses the public
boundary.

The prompt proof uses a process proxy because A1's accepted commands cannot naturally
prompt for credentials. It proves closed stdin, prompt variables, deadline, and
termination; later mutating commands require their own real prompt tests.

A1 chooses detached groups for reliable descendant termination while the daemon lives.
After a hard daemon kill, an orphan has no upper lifetime bound because the parent timer
and kill path no longer exist. This is acceptable only because A1 commands are read-only,
stdin is closed, optional locks are disabled, no network command exists, and A1 creates no
durable intent. CT-04C must not inherit this lifecycle and assume bounded orphan lifetime
for `worktree add`.

Production A1 creates no temporary file, log, marker, directory, lock, or other file
anywhere on the host. Filesystem calls are observation only. Test fixtures are outside
that production claim.

## 9. Root, path, repository-class, and ownership policy

### 9.1 Root topology

`allowedSourceRoots`:

- 1–32;
- absolute, normalized, existing directories;
- no symlink component;
- `realpath(root) === root`;
- pairwise non-overlapping in both ancestor directions.

`reservedRoots`:

- optional and empty by default;
- 0–32 absolute, normalized paths;
- existing components must be symlink-free and resolve as written;
- pairwise non-overlapping with one another in both directions;
- pairwise non-overlapping with every source root in both directions.

Reserved roots need not exist, share a parent, or be descendants of a data root. A sibling
or separate-filesystem reserved root is valid. Equality, ancestor, or descendant overlap
is invalid. A2 passes its data root as reserved; future artifact/worktree roots are passed
only when those features actually configure them.

No reserved directory is created.

The CT-04A slice-specific rule controls: a requested repository must be strictly below
exactly one source root, not equal to it.

### 9.2 Admission order

1. Return `aborted` immediately for a pre-aborted signal.
2. Validate 1–4096 UTF-8 bytes, absolute, normalized, and no NUL.
3. Find exactly one strictly containing source root by path components.
4. Reject overlap with every reserved root.
5. `lstat` every path component; reject every symlink.
6. Require existing directory and `realpath(request) === request`.
7. Record whether a strict ancestor contains a Git marker for later classification.
8. Require `<request>/.git` to be a real directory, not a symlink/file; absence is
   non-primary layout.
9. Reject `.git/commondir` and a symlinked `.git/config`.
10. `lstat` hooks; a hooks-directory symlink is recorded as risk without following.
11. Require top-level and `.git` ownership by non-root daemon effective UID.
12. Run identity with the discovery ceiling.
13. Collect bigint top/common stat evidence.
14. Run local risk-signal scan and enumerate hooks without following symlinks.
15. Repeat realpath/lstat/stat over top, `.git`, config, and hooks; structural/inode race
    yields `observation-raced`.
16. Check total inspection budget and return one parsed observation.

Bare repositories, arbitrary subdirectories, linked worktrees, submodule checkouts,
separate Git directories, `.git/commondir`, and redirected/non-primary layouts are
rejected.

Spaces, leading-dash basenames, metacharacters, tabs, and newlines are legal when the
structure passes. The path is used only as `cwd` and one per-invocation environment value,
never as argv or shell text.

### 9.3 Ownership and unreadable metadata

Top-level and common Git directory must be owned by the daemon's effective UID. No
`safe.directory` escape exists. UID mismatch or Git's stable C-locale dubious-ownership
diagnostic becomes `ownership-refused` without raw stderr.

Unreadable config/hooks is distinct:

- unreadable `.git/config` or hooks enumeration returns
  `repository-metadata-unreadable`;
- it never becomes `no-signals-in-scanned-set`;
- real mode-000 tests run where permissions are effective; a deterministic filesystem
  fault provider is mandatory when root/capabilities would bypass mode bits.

The strict no-symlink policy is deliberately operationally restrictive. The current
dogfood checkout was verified to have no symlink path component, so the strict branch is
affordable for the first workload. Operations documentation tells future operators that a
symlinked source layout will be rejected before Git.

The trust boundary excludes a malicious concurrent local owner, root, or mount
administrator. Postflight detects path/layout/inode replacement, not same-inode config or
hook-content edits. Observations are timestamped; A2 repeats inspection before storage and
later mutation re-inspects.

## 10. Identity parsing and honest failure discrimination

### 10.1 Successful acceptance

The identity parser never line-splits the path-valued prefix. It constructs:

```text
<top>\n<gitDir>\n<gitDir>\n
```

and requires an exact raw-byte prefix, then one exact tail:

```text
false\ntrue\nsha1\n
false\ntrue\nsha256\n
```

Whole-output byte equality remains the only success test. This proves exact top-level,
Git/common directory, non-bare, inside-work-tree, supported format, and no extra output,
including when a path contains newline.

### 10.2 Failure discrimination

On an exit-0 mismatch, the classifier works backward from the final newline to isolate the
three path-free tail tokens without splitting the path prefix:

```text
is-bare-repository
is-inside-work-tree
object-format
```

Rules:

- bare `true` or inside-work-tree `false` → `not-primary-repository`;
- structurally valid unknown object format → `unsupported-object-format`;
- supported tail plus a path prefix that resolves to a strict ancestor top-level or a
  different top-level/Git/common directory → `not-primary-repository`;
- only output that cannot be structurally framed as three NL-terminated path fields and
  three NL-terminated tokens is `malformed-identity-output`.

Known expected paths make newline-bearing path framing deterministic: after the three
rightmost tokens are removed, the classifier first tests exact expected Git/common
suffixes, then exact candidate strict-ancestor templates recorded during admission.

Nonzero classification under `LC_ALL=C`:

- `detected dubious ownership` → `ownership-refused`;
- `must be run in a work tree` → `not-primary-repository`;
- `not a git repository` after a requested `.git` marker:
  - strict ancestor Git marker observed → `not-primary-repository`;
  - no ancestor marker → `not-git-repository`;
- unknown repository extension diagnostic → `unsupported-repository-extension`;
- all other bounded nonzero exits → `git-command-failed`.

Raw diagnostics never escape. Truncated newline or corrupt framing remains
`malformed-identity-output`, distinct from every class rejection.

## 11. Observation, scan scope, recorded parsing, and comparison

### 11.1 Observation

```ts
interface RepositoryObservationShape {
  readonly observationVersion: 1;
  readonly inspectionPolicyVersion: number;
  readonly observedAt: string;
  readonly gitVersion: { readonly major: number; readonly minor: number;
    readonly patch: number };
  readonly canonicalTopLevel: string;
  readonly canonicalGitDirectory: string;
  readonly canonicalCommonGitDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly coreIdentity: {
    readonly topLevelInode: string;
    readonly commonDirectoryInode: string;
    readonly fingerprintSha256: string;
  };
  readonly environmentalEvidence: {
    readonly topLevelDevice: string;
    readonly commonDirectoryDevice: string;
  };
  readonly riskScan: RepositoryRiskScanObservation;
}
```

Bigint filesystem values are canonical unsigned decimal strings. Device IDs are excluded
from core fingerprint. There is no claim that startup can predict future device stability.

### 11.2 Self-describing risk scan

```ts
interface RepositoryRiskScanObservation {
  readonly scanScopeVersion: 1;
  readonly scannedKeyPattern:
    '^(extensions\\.worktreeconfig|core\\.(hookspath|fsmonitor|worktree)|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process)|include\\.path|includeif\\..*\\.path)$';
  readonly classification: 'no-signals-in-scanned-set' | 'signals-observed';
  readonly signals: readonly RepositoryRiskSignal[];
}
```

Signals are sorted/unique:

```text
core-hooks-path
core-fsmonitor
core-worktree-redirection
diff-external
diff-driver-command
diff-driver-textconv
filter-clean
filter-smudge
filter-process
config-include
conditional-config-include
worktree-config-enabled
hooks-directory-symlink
hook-entry
```

No value or hook content is read. `extensions.worktreeconfig` and `core.worktree` are
signals by presence, regardless of value.

The self-description prevents `no-signals-in-scanned-set` from meaning “safe repository”
or “no external-execution configuration.” Unscanned config-key classes include,
individually:

- `alias.*` shell aliases — inert because A1 invokes fixed builtin subcommands;
- `merge.*.driver` — no merge occurs;
- `core.sshcommand` and `credential.helper` — no remote/credential operation occurs;
- `init.templatedir` — A1 never initializes a repository;
- `uploadpack.packobjectshook` — no upload-pack occurs;
- `core.alternaterefscommand` — no alternate-ref enumeration occurs;
- `sequence.editor` — no sequencing/rebase occurs;
- `gpg.program` — no signing/verification command occurs;
- `trailer.*.command` — no trailer processing occurs;
- `submodule.*.update = !command` — no submodule update occurs.

Unscanned files remain:

- `.git/config.worktree` contents after the extension signal;
- submodule `.git/modules/*/config`;
- `.gitattributes` and `.git/info/attributes`;
- hook contents;
- config include targets/values.

These are inert under A1's two repository read commands, not certified safe for future
mutation. A later mutating slice requires a newly reviewed scan.

### 11.3 Comparison

After both inputs pass runtime parsing and policy versions match:

```ts
interface RepositoryObservationComparison {
  readonly coreDifferences: readonly CoreEvidenceDifference[];
  readonly environmentalDifferences: readonly EnvironmentalEvidenceDifference[];
  readonly riskScanDifferences: readonly RiskScanDifference[];
  readonly sameCoreIdentity: boolean;
  readonly sameEnvironmentalEvidence: boolean;
  readonly sameRiskScanEvidence: boolean;
}
```

Core differences cover canonical top, Git/common directories, object format, and both
inodes. Environmental differences cover device IDs. Risk differences cover scan scope and
signals.

A1 never returns durable `active`, `unavailable`, `identity-evidence-changed`,
`identity-mismatch`, `blocked`, `reaffirmed`, or `retired`.

## 12. Failure taxonomy and complete subject-class mapping

Every public failure includes:

```text
category
code
subject
operation
retryability
fixed message
bounded allowlisted evidence
```

`subject` is observational, not a durable-state decision:

```text
caller-input
policy-configuration
host-environment
repository-unavailable
repository-class-changed
git-boundary-fault
recorded-evidence-invalid
evidence-not-comparable
```

Complete mapping:

| Code | Subject |
| --- | --- |
| `invalid-options` | policy-configuration |
| `unsupported-platform` | host-environment |
| `root-daemon-refused` | host-environment |
| `invalid-root-policy` | policy-configuration |
| `git-not-found` | host-environment |
| `git-not-executable` | host-environment |
| `git-executable-changed` | host-environment |
| `unsupported-git-version` | host-environment |
| `invalid-path` | caller-input |
| `outside-allowed-root` | policy-configuration |
| `reserved-root-overlap` | policy-configuration |
| `path-unavailable` | repository-unavailable |
| `symlink-rejected` | repository-class-changed |
| `ownership-refused` | repository-class-changed |
| `repository-metadata-unreadable` | repository-unavailable |
| `not-primary-repository` | repository-class-changed |
| `not-git-repository` | repository-class-changed |
| `unsupported-object-format` | repository-class-changed |
| `unsupported-repository-extension` | repository-class-changed |
| `spawn-failed` | git-boundary-fault |
| `aborted` | host-environment |
| `timed-out` | git-boundary-fault |
| `stdout-overflow` | git-boundary-fault |
| `stderr-overflow` | git-boundary-fault |
| `signal-terminated` | git-boundary-fault |
| `git-command-failed` | git-boundary-fault |
| `invalid-output-encoding` | git-boundary-fault |
| `malformed-version-output` | git-boundary-fault |
| `malformed-identity-output` | git-boundary-fault |
| `malformed-feature-output` | git-boundary-fault |
| `feature-count-exceeded` | git-boundary-fault |
| `observation-raced` | repository-unavailable |
| `recorded-observation-invalid` | recorded-evidence-invalid |
| `unsupported-observation-version` | recorded-evidence-invalid |
| `inspection-policy-version-mismatch` | evidence-not-comparable |

The code union, `ALL_REPOSITORY_INSPECTION_ERROR_CODES`, and total subject-mapping switch
are co-located. The switch has an `assertNever`; tests assert exact set equality. Adding a
code without a subject is a compile/test failure.

Public evidence permits only configured numeric bounds, fixed command kind, exit/signal,
Git version tuple, numeric UID, and fixed path-policy reason. It excludes paths by default,
raw output, config values/names, environment, credentials, and arbitrary system messages.
A2 owns public path disclosure and HTTP mapping.

### 12.1 Failed reinspection handoff

If inspection fails, no observation exists and `compareRepositoryObservations` is
unreachable. A2 consumes `subject` plus operation context:

- repository-unavailable → candidate nonterminal unavailable handling;
- repository-class-changed → block as a candidate identity/class replacement;
- caller-input → request rejection without repository-state inference;
- policy-configuration → feature/configuration failure without identity mutation;
- host-environment → host/feature unavailable without identity mutation;
- git-boundary-fault → bounded operational failure without identity mutation absent
  positive replacement evidence;
- recorded-evidence-invalid/evidence-not-comparable → integrity/policy block; never
  identity-equal.

A2 still owns the transaction, durable state, audit, event, and operator recovery. The A1
class states what the failure concerns; it does not perform that mapping itself.

## 13. Structural test/fixture boundary and deterministic fixture environment

All Git tests and fixture builders live under `packages/git/test/`. Production `src`
cannot import them.

`packages/git/tsconfig.test.json`:

- extends the workspace base;
- sets `noEmit: true`;
- has package-root `rootDir`;
- includes `test/**/*.ts`;
- references the production Git project.

Root `typecheck` becomes:

```text
tsc -b
tsc --noEmit -p apps/web
tsc --noEmit -p packages/git/tsconfig.test.json
```

Vitest's node project adds:

```text
packages/*/test/**/*.test.ts
```

The scope checker:

- walks both `src` and `test` when present;
- applies Exo Stack and NUL checks to both;
- treats a module as test-capability code only when its normalized path is structurally
  below `packages/*/test/` or it is an existing supported application test;
- does not exempt a production file merely because its filename contains
  `test-support`;
- allows canonical `node:child_process` in exactly the anchored path
  `packages/git/src/command-runner.ts`;
- rejects it in every other production module;
- continues to reject unprefixed `child_process`, shell libraries, and generic Git
  libraries everywhere in production.

The package export-map test proves:

- only `"."` is exported;
- no wildcard/deep export can expose `dist/command-runner.js`;
- the public entry point exports no raw runner/command/environment carrier.

The emitted-dist test builds the Git package and proves:

- no test or fixture module appears in `packages/git/dist`;
- the only emitted module importing `node:child_process` is the anchored command runner;
- emitted production contains only the three command variants.

This structural convention is recorded in ADR-008 for `packages/git` only. Retrofitting
other packages is expressly outside A1.

### 13.1 Real fixture construction

Temporary roots are created test-only, then `realpath`-resolved before becoming source or
fixture paths. Fixture Git commands use absolute executable/argument arrays and a newly
constructed deterministic environment with at least:

```text
LC_ALL=C
LANG=C
GIT_TERMINAL_PROMPT=0
GIT_PAGER=cat
PAGER=cat
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_SYSTEM=/dev/null
GIT_CONFIG_GLOBAL=/dev/null
GIT_ATTR_NOSYSTEM=1
```

They receive no inherited HOME, Git overrides, hook/template config, or credential
configuration. Fixture-specific user identity is supplied by fixed `-c user.name` and
`-c user.email`; commits use `--no-gpg-sign`.

Test-only fixture commands:

```text
git init --initial-branch=main <absolute-temp-path>
git -C <path> -c user.name=CraftingTable \
  -c user.email=craftingtable.invalid add --all
git -C <path> -c user.name=CraftingTable \
  -c user.email=craftingtable.invalid commit --no-gpg-sign -m initial
git init --bare <absolute-temp-path>
git -C <primary> worktree add --detach <absolute-temp-path> HEAD
git init --separate-git-dir=<absolute-git-dir> <absolute-worktree-path>
git -C <path> config --local <fixed-key> <fixed-value>
git -C <path> config --worktree <fixed-key> <fixed-value>
```

These are deliberately unbounded test helpers and inherit none of the production runner's
authority or guarantees. Their structural location prevents them from shipping.

The fixture-determinism test runs under a hostile parent HOME/global config containing
`init.templatedir`, `core.hookspath`, and `include.path`, then under an empty HOME, using
an injected clock. Resulting fixtures/observations are byte-equivalent.

Purpose-built executables cover environment capture, prompt EOF, output faults, hangs,
TERM refusal, descendant termination, version variants, diagnostics, and races. Each
embeds `process.execPath` in its shebang and requires no child PATH.

Ownership, unreadable-mode, and SHA-256 real cases run when supported; deterministic stat,
filesystem-fault, and output proxies remain mandatory fallbacks rather than silent skips.

## 14. Permanent A1 adversarial and proof matrix

Every row is an implementation obligation.

### 14.1 Configuration/executable

| ID | Case | Expected/proof file |
| --- | --- | --- |
| A1-CFG-001 | import without creation | no fs/spawn; `test/configuration.test.ts` |
| A1-CFG-002 | explicit valid executable | canonical/versioned |
| A1-CFG-003 | relative/missing/directory/non-executable | typed creation failure |
| A1-CFG-004 | explicit executable plus search path | explicit wins; search ignored |
| A1-CFG-005 | omitted executable, explicit mixed search entries | only absolute entries eligible |
| A1-CFG-006 | no eligible Git | `git-not-found`; daemon unaffected |
| A1-CFG-007 | plain/Apple/Windows versions | accepted leading tuple |
| A1-CFG-008 | malformed/empty/overflow/1.x/2.31.1 | typed reject |
| A1-CFG-009 | exact min/max reconciled bounds | accepted |
| A1-CFG-010 | invalid/noninteger/incoherent bounds | reject |
| A1-CFG-011 | executable replaced; two concurrent inspections race it | no replacement spawn; coherent typed outcomes |
| A1-CFG-012 | symlinked search entry to executable wrapper | canonical target, version proof required |
| A1-CFG-013 | POSIX unavailable | `unsupported-platform` |
| A1-CFG-014 | effective UID 0 | `root-daemon-refused` |

All rows live in `packages/git/test/configuration.test.ts` unless named otherwise.

### 14.2 Root/path/repository class

| ID | Case | Expected/proof |
| --- | --- | --- |
| A1-PATH-001 | canonical roots, empty/sibling/separate-filesystem reserved list | accepted |
| A1-PATH-002 | no/>32 source or >32 reserved roots | reject |
| A1-PATH-003 | relative/non-normalized/missing/non-directory source root | reject |
| A1-PATH-004 | symlink root/component | reject |
| A1-PATH-005 | duplicate/nested source roots | reject |
| A1-PATH-006 | any source/reserved equality or ancestor overlap | reject both directions |
| A1-PATH-007 | reserved roots equal/nested with each other | reject |
| A1-PATH-008 | nonexisting disjoint reserved suffix | accepted, no creation |
| A1-PATH-009 | exact primary below root | observation succeeds |
| A1-PATH-010 | request equals source root | reject strict-below |
| A1-PATH-011 | empty/relative/NUL/oversized/non-normalized request | pre-Git reject |
| A1-PATH-012 | missing/nondirectory | unavailable, zero spawn |
| A1-PATH-013 | outside/component-prefix lookalike | reject |
| A1-PATH-014 | reserved overlap | reject |
| A1-PATH-015 | symlink at each request position | reject/no follow |
| A1-PATH-016 | subdirectory with empty `.git` inside ancestor repo | `not-primary-repository`, not malformed |
| A1-PATH-017 | bare repo and `.git` repo with `core.bare=true` | `not-primary-repository` |
| A1-PATH-018 | linked worktree/submodule `.git` file | `not-primary-repository` |
| A1-PATH-019 | separate Git dir, commondir, or `core.worktree` redirect | `not-primary-repository` |
| A1-PATH-020 | `.git`/config symlink; hooks symlink | former reject; latter signal/no follow |
| A1-PATH-021 | dash/space/metachar/tab/newline path | one cwd/env value; no argv/shell confusion |
| A1-PATH-022 | structural swap during inspection | `observation-raced` |
| A1-PATH-023 | UID mismatch | `ownership-refused` |
| A1-PATH-024 | Git dubious ownership diagnostic | classified/no raw stderr |
| A1-PATH-025 | unreadable config/hooks | `repository-metadata-unreadable`, never clean scan |
| A1-PATH-026 | unknown repository extension | `unsupported-repository-extension` |
| A1-PATH-027 | genuinely truncated/corrupt identity stdout | `malformed-identity-output`, distinct from 016/017/019 |
| A1-PATH-028 | ceiling present in nested-repo case | Git cannot ascend; removing it still fails by template/classification |

Root-only cases live in `test/path-policy.test.ts`; real Git/class cases live in
`test/repository-inspector.test.ts`; diagnostic proxies may live in
`test/command-runner.test.ts`.

### 14.3 Fixed process

| ID | Case | Expected/proof in `test/command-runner.test.ts` |
| --- | --- | --- |
| A1-GIT-001 | each closed kind | exact executable/argv/cwd/env |
| A1-GIT-002 | hostile path | cannot select option/subcommand |
| A1-GIT-003 | inherited Git dir/worktree/index/object/config | absent |
| A1-GIT-004 | inherited HOME/PATH/askpass/SSH/proxy/trace | absent |
| A1-GIT-005 | hostile global config | `/dev/null`; no leaked key/marker |
| A1-GIT-006 | prompt proxy | EOF, prompt disabled, bounded |
| A1-GIT-007 | stdout at bound | normal parse possible |
| A1-GIT-008 | stdout above bound | group termination/no partial success |
| A1-GIT-009 | stderr at bound | normal outcome classification |
| A1-GIT-010 | stderr above bound | independent overflow |
| A1-GIT-011 | per-command deadline | TERM/KILL and timeout |
| A1-GIT-012 | caller abort | TERM/KILL and aborted |
| A1-GIT-013 | already-aborted inspect | zero filesystem/spawn |
| A1-GIT-014 | TERM ignored/child spawned | group KILL after grace |
| A1-GIT-015 | spawn error/signal/nonzero | distinct codes; settle once |
| A1-GIT-016 | overflow/timeout races close | first failure dominates |
| A1-GIT-017 | extra/malformed/invalid UTF-8 output | reject |
| A1-GIT-018 | one successful inspect | exactly two spawns |
| A1-GIT-019 | process import elsewhere | scope gate rejects |
| A1-GIT-020 | entry point/exports map | no raw/deep runner access |
| A1-GIT-021 | 4096-near path at 16384/default stdout | identity does not overflow |
| A1-GIT-022 | 257 short keys vs 200 long keys | count-exceeded vs byte-overflow precedence |
| A1-GIT-023 | total inspection budget | no new step/spawn after expiry |

### 14.4 Observation/recording/comparison

| ID | Case | Expected/proof |
| --- | --- | --- |
| A1-EVID-001 | real SHA-1 primary | exact observation |
| A1-EVID-002 | SHA-256 | real when supported, mandatory synthetic parser |
| A1-EVID-003 | embedded newline paths | raw byte validation succeeds |
| A1-EVID-004 | wrong paths/booleans/format/extra bytes | honest distinct classification |
| A1-EVID-005 | malformed feature NUL/UTF-8/exit | typed failure |
| A1-EVID-006 | exit 1 empty | no signals in scanned set |
| A1-EVID-007 | >256 short keys | count failure |
| A1-EVID-008 | every scanned config/hook signal | sorted signals, no value/content |
| A1-EVID-009 | worktree config extension | signal present |
| A1-EVID-010 | only sample hooks/no keys | `no-signals-in-scanned-set` plus exact scope |
| A1-EVID-011 | alias/merge/credential/etc. unscanned classes | scope records omission; none executes |
| A1-EVID-012 | `core.worktree` configured compatibly | layout signal observed |
| A1-EVID-013 | identical parsed observations | empty differences |
| A1-EVID-014 | each core field changes | named core difference |
| A1-EVID-015 | device-only changes | environmental only |
| A1-EVID-016 | risk signal change | risk-scan only |
| A1-EVID-017 | length-boundary ambiguity | fingerprints remain distinct |
| A1-EVID-018 | missing path | failure; comparison unreachable |
| A1-EVID-019 | recorded missing inode/truncated/number inode | parser rejects |
| A1-EVID-020 | observationVersion 2 | unsupported version; no comparison |
| A1-EVID-021 | policyVersion differs | not-comparable outcome; no equality booleans |
| A1-EVID-022 | stored fingerprint altered | parser rejects |
| A1-EVID-023 | every error code | total code→subject mapping and `assertNever` |
| A1-EVID-024 | two concurrent normal inspections | isolated observations, no shared mutable corruption |

Live observation cases are in `test/repository-inspector.test.ts`; parsing/fingerprint/
comparison/exhaustiveness cases are in `test/comparison.test.ts`.

### 14.5 Boundary, fixture, build, and crash

| ID | Case | Expected/proof |
| --- | --- | --- |
| A1-BND-001 | CT-03 daemon start without Git config | unchanged; no server import |
| A1-BND-002 | package import only | no fs/process |
| A1-BND-003 | dependency graph | one runtime package/authority |
| A1-BND-004 | emitted `dist` | production only; one child-process import; no fixture/test |
| A1-BND-005 | package exports | `"."` only, no wildcard/deep runner |
| A1-BND-006 | hostile global fixture environment | byte-equivalent deterministic result |
| A1-BND-007 | inspect repository pre/post | no repository or host file created/changed by production |
| A1-BND-008 | hard daemon death limitation | no bounded orphan claim/no reconciliation state |
| A1-BND-009 | Vitest collection | all five moved test modules collected |
| A1-BND-010 | scope-check fake production `x-test-support.ts` | child-process import rejected |
| A1-BND-011 | target diff inventory | no schema/route/event/browser file |

Proof is distributed among `test/configuration.test.ts`, `test/repository-inspector.test.ts`,
scope-checker tests, Vitest configuration tests/collection evidence, build inspection, and
the full gate.

## 15. Parent protected-equivalent mapping

A1 never claims parent CT-04A completion. It supplies these contributions:

### 15.1 REG-PATH

| Parent ID | A1 proof | A2 remainder |
| --- | --- | --- |
| REG-PATH-001 | PATH-009/EVID-001 | Owner registration/durability |
| REG-PATH-002 | none | role denial and zero inspector |
| REG-PATH-003 | PATH-011 | service maps before state |
| REG-PATH-004 | PATH-012 | no success state/event |
| REG-PATH-005 | PATH-013 | service mapping |
| REG-PATH-006 | PATH-016 | service mapping |
| REG-PATH-007 | PATH-017 | service mapping |
| REG-PATH-008 | PATH-018/019 | service mapping |
| REG-PATH-009 | PATH-006/014 | A2 supplies configured managed root when present |
| REG-PATH-010 | PATH-006/014 | A2 supplies data/artifact roots when present |
| REG-PATH-011 | PATH-004/015/020 | service mapping |
| REG-PATH-012 | PATH-021/EVID-003 | strict request/display-name behavior |

### 15.2 REG-ID

| Parent ID | A1 proof | A2 remainder |
| --- | --- | --- |
| REG-ID-001 | EVID-013 | append verification evidence |
| REG-ID-002 | PATH-022/EVID-014 | block and record mismatch |
| REG-ID-003 | none | structural cross-workspace uniqueness |
| REG-ID-004 | none | same-workspace idempotency |
| REG-ID-005 | EVID-018 plus subject mapping | durable unavailable |
| REG-ID-006 | EVID-004/014 | durable core mismatch |
| REG-ID-007 | EVID-014/015 | dev-only reaffirmation versus inode mismatch |
| REG-ID-008 | EVID-008–012 | persist exact scan scope/handling |

### 15.3 REG-GIT

| Parent ID | A1 proof | A2 remainder |
| --- | --- | --- |
| REG-GIT-001 | GIT-001/018 | consume inspector only |
| REG-GIT-002 | GIT-002/PATH-021 | no public path-to-argv |
| REG-GIT-003 | GIT-003–005 | preserve environment |
| REG-GIT-004 | GIT-006/011/014 | later real mutating prompt proof |
| REG-GIT-005 | GIT-007/008/016 | no state on overflow |
| REG-GIT-006 | GIT-009/010/016 | no state on overflow |
| REG-GIT-007 | GIT-011/016/023 | no state on timeout |
| REG-GIT-008 | GIT-020/BND-005 | A2 strict HTTP schema |

OWN-REP-001..006, JRN-REP-001..005, A-API-001, A-MIG-001, A-NOTIFY-001, and
A-ROLE-001 remain wholly A2. A-DOC-001 is partially addressed by accurate A1 status docs
and completed after A2.

Process proofs:

- P-PROCESS-001: this accepted plan must be operator-approved and committed before code;
- P-PROCESS-002: proposal, review, and disposition are immutable evidence;
- P-PROCESS-003: completion records the real stable implementation head only;
- P-PROCESS-004: history-independent routine hash plus pinned release comparison.

## 16. Protected-package verification

Routine `pnpm check` runs only the history-independent filesystem verifier:

```text
node scripts/check-ct04-protected-package.mjs
```

It requires the exact two-file manifest and literal hashes and rejects missing, extra, or
changed files. Its tests mutate an `expected:` line and add an extra file in a scratch
copy, proving the checker fails.

The pinned Git comparison is a release/merge evidence step, not a routine shallow-clone
gate:

```text
git cat-file -e 06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4^{commit}
git diff --exit-code 06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4 -- protected/
```

If `cat-file` fails, verification reports “protected-package pin is unavailable in this
clone” and does not claim the package changed. Only when the pin exists does a nonempty
diff mean immutability failure.

## 17. Documentation and ADR updates

- ADR-016 records lazy observation-only authority, the three commands, environment,
  ceiling, bounds, process/orphan policy, path/UID trust, runtime parse boundary, scan
  scope, and A2 separation.
- ADR-008 records the single anchored process-import allowlist, Git test-outside-src
  convention, separate test typecheck/Vitest collection, emitted-dist proof, and protected
  hasher.
- `docs/architecture.md` adds the real but uncomposed Git package direction. It does not
  claim to repair a duplicate server node that does not exist.
- `docs/security.md` records no shell/remote, diagnostics, path/UID rejection, exact scan
  scope, and local-owner limits.
- `docs/operations.md` records Git 2.32/POSIX/non-root requirements, explicit production
  executable/search-path requirement, strict no-symlink consequence, no active repository
  environment setting yet, and unchanged planning-only startup.
- README/CLAUDE identify accepted CT-03 as the composed runtime and A1 as the active
  implementation slice without claiming registration is available.

No UI-principles change occurs.

## 18. Explicit A2 handoff

A2 plans against the accepted implementation, not assumed proposal types.

1. Authorize active membership/role before calling A1.
2. Lazily create/memoize the inspector only for authorized repository operations.
3. Pass explicit executable or search path and configured source/data/reserved roots; do
   not use ambient daemon PATH.
4. Registration performs two complete inspections, the second immediately before storage.
5. Parse every stored observation through `parseRecordedObservation`.
6. Never compare when inspection fails or policy versions differ.
7. Consume error `subject` plus operation context according to section 12.1; A2 retains
   durable-state authority.
8. Store immutable, self-describing inspection/scan evidence and expose its age.
9. Keep core differences, device-only differences, and risk-scan differences separate.
10. Own unavailable, evidence-changed, reaffirmation, mismatch, retirement, uniqueness,
    display name, binding, audit, event, notifier, routes, and browser behavior.
11. Never import child process, construct argv/environment, deep-import the runner, or add
    a second Git execution path.
12. Reinspect execution surfaces before any later mutation; A1's scanned-set result is not
    mutation authorization.
13. Do not assume A1's detached runner bounds an orphan after hard daemon death. CT-04C
    needs side-effect-specific durable intent/reconciliation and a newly reviewed process
    lifecycle.
14. Run the complete original CT-04A protected suite only after A1+A2 integration.

Already binding A2 decisions remain those recorded by the parent disposition:
device-only reaffirmation preserves ID/bindings; retirement and explicit unbind remain;
workspace events gain structural repository correlation through rebuild; one registration
audit action uses outcomes; inspection evidence is append-only; no automatic startup
reconciliation; one repository may bind multiple same-workspace projects.

## 19. Explicit exclusions

A1 creates no:

- schema, migration, SQLite row, repository state, inspection record, policy, or binding;
- domain repository ID/record;
- HTTP/SSE contract, route, service, authorization behavior, audit, event, or notifier;
- server startup dependency;
- browser route, projection, activity, view, fetch, or behavior;
- inspected-repository or host file/directory;
- change request, target ref, branch, checkout, commit, worktree, status, diff, artifact,
  agent, verification, review, readiness, merge, remote Git, credential helper, or hosted
  provider behavior.

The only production child-process authority is the private bounded runner in
`packages/git/src/command-runner.ts` with the three variants in section 7. Test fixtures
are structurally non-production and unbounded.

## 20. Deterministic implementation verification

Only commands actually run may appear in completion evidence. Planned commands:

```text
corepack pnpm install --frozen-lockfile
pnpm check
pnpm exec tsc --noEmit -p packages/git/tsconfig.test.json
pnpm exec vitest run packages/git/test
pnpm exec vitest run scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.test.mjs
node scripts/check-forbidden-scope.mjs
node scripts/check-ct04-protected-package.mjs
pnpm exec tsc -b packages/git
find packages/git/dist -type f -print
git cat-file -e 06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4^{commit}
git diff --exit-code 06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4 -- protected/
sha256sum protected/README.md \
  protected/CT-04-protected-acceptance-spec.yaml
git status --short
```

`pnpm check` includes the history-independent hasher, full CT-01..03 test/E2E suite, moved
test typecheck, and scope check. Git-package tests contain real temporary repositories and
fault proxies.

## 21. Review-finding reconciliation appendix

| Finding | Operator disposition | Accepted-plan sections | Permanent proof cases |
| --- | --- | --- | --- |
| A1-F-01 | accepted as recommended | 10, 12, 14.2 | PATH-016/017/019/026/027/028, EVID-004 |
| A1-F-02 | accepted as recommended | 12, 12.1, 18 | EVID-018/023, exhaustive code→subject test |
| A1-F-03 | accepted as recommended | 5, 11.1/11.3, 12 | EVID-019–022 |
| A1-F-04 | accepted as recommended | 6, 9.1 | PATH-001/006/007/008/014 |
| A1-F-05 | accepted as written | 7.2, 11.2 | EVID-008–012/016 |
| A1-F-06 | accepted as written | 13.1 | BND-006, fixture determinism |
| A1-F-07 | accepted with operator structural remedy | 3.2, 4, 13, 19 | BND-004/005/009/010, GIT-019/020 |
| A1-F-08 | accepted as written | 6.1, 8.2 | CFG-009/010, GIT-007–013/021–023 |
| A1-F-09 | accepted as written | 8.2, 18 | BND-008; documented non-testable limitation |
| A1-F-10 | accepted as written | 8.1, 10 | PATH-016/028, GIT-001 |
| A1-F-11 | accepted as written | 6.2, 9.3, 17 | CFG-004/005/012/014, PATH-023/024 |
| A1-F-12 | accepted as written | 16, 20 | protected verifier negative tests; release pin check |
| A1-F-13 | accepted as written | 9.3, 17 | PATH-004/015/020; operations documentation |

Coverage-gap reconciliation:

| Accepted gap | Plan/proof |
| --- | --- |
| error classification exhaustiveness | section 12; EVID-023 and compile `assertNever` |
| recorded-observation validation | sections 5/11; EVID-019–022 |
| concurrent inspection | CFG-011 and EVID-024 |
| unreadable config/hooks | PATH-025 |
| unknown repository extension | PATH-026 |
| exact spawn count | GIT-018 |
| deep-import resistance | GIT-020/BND-005 |
| fixture determinism | BND-006 |
| no host file creation | section 8.2/19; BND-007 |
| moved test collection | BND-009 |
| filename-based scope escape | BND-010 |
| pre-aborted optional signal | GIT-013 |

All thirteen findings are reconciled. None is rejected, deferred, or assigned back to A2
except the durable semantics that were already outside A1.

## 22. Implementation handoff and stop condition

The implementation generation must remain within this tree, command surface, taxonomy,
and proof matrix. A material discrepancy stops work for operator direction.

Before code:

1. operator reviews this plan;
2. operator explicitly approves it;
3. this plan and its proposal/review/disposition evidence are committed.

Stop now. Do not modify production source, create implementation reports, begin A2
planning, or create an implementation commit in this turn.
