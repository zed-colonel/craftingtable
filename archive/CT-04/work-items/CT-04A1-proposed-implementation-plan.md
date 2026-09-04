# CT-04A1 proposed implementation plan

Status: proposed for focused independent design review; not accepted for implementation

Scope: CT-04A1 — Trusted Git inspection boundary

Source baseline:
`abc5f37815ad76430cae989224afde817d77a047`

Current planning head:
`c42907b249578eca8ba51638543a069b8e0e880c`

Protected-package pin:
`06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`

Protected acceptance SHA-256:
`ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`

## 1. Authorization and stage boundary

The unified CT-04A proposal was rejected for implementation. The operator
adopted this child decomposition:

```text
CT-04A1  trusted Git and filesystem observation
CT-04A2  authorized durable repository registry and project binding
```

This document is the only authorized write in the present stage. It is a new
source-specific proposal, not an accepted implementation plan. Production code
must not change until a focused independent A1 design review is adjudicated,
an A1 accepted plan is written, and the operator separately authorizes and
commits that plan.

A1 accepts an untrusted path and explicit programmatic inspection policy. It
returns either a bounded typed observation or a bounded typed observational
failure. It does not authorize the path, store the observation, or decide what
the observation means for application state.

## 2. Fresh checkout reconciliation

The current branch is `ct-04a-git-foundation` at
`c42907b249578eca8ba51638543a069b8e0e880c`. It descends from both the pinned
source baseline and the protected-package pin:

```text
abc5f37  Merge CT-03: plan import and dashboard into main
06abcff  CT-04: add decomposed source-grounded package
b6eda1d  operator chore: CT-04A review adjudication and split decision
c42907b  operator planning/implementation feedback-loop learnings
```

The two commits after `06abcff` add only historical planning, review,
adjudication, and process-learning documents. A path-limited diff confirms no
change after `06abcff` under `apps/`, `packages/`, `scripts/`, `docs/`,
`README.md`, `CLAUDE.md`, `package.json`, or `pnpm-lock.yaml`. Production
source is therefore the same source reviewed for the unified proposal. The
worktree was clean before this proposal was created.

Historical artifact hashes:

```text
CT-04A proposed plan
575df9d9caf427661696f747f6083dc8fa6adce81a3a7785db125b6b8791ddcb

CT-04A independent design review
98b180bc8ea8c556a90d8e8f836398d5ac0e60e92329193c45ee15009886cb0a

CT-04A operator feedback and disposition
90817ba5e6240087102e66e9773e07da75f418b75275dede561fc6047021f2a2
```

The protected package was introduced by `06abcff`, not by the source
baseline. The two pins have different purposes:

- `abc5f37…` is the source-reconciliation baseline;
- `06abcff…` is the immutable protected-package comparison pin.

The protected directory currently contains exactly:

```text
protected/README.md
4e857aca74d4c96f869a2f30e73f0aeb0153f8de2c0e77f972fea325647119fd

protected/CT-04-protected-acceptance-spec.yaml
ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
```

`git diff --exit-code 06abcff… -- protected/` succeeds and there are no
untracked protected files.

### 2.1 Source-assessment drift

`CT-04-source-assessment.md` section 11 says the baseline README described
CT-02 as current. The README at both `abc5f37` and current HEAD actually says
CT-03. The assessment statement is stale; it is preserved as historical
evidence rather than rewritten. A1 documentation will identify accepted CT-03
as the inherited runtime and A1 as the active implementation slice.

### 2.2 Additional source-specific correction

The original feature-name regex used mixed-case key spellings such as
`core.hooksPath`. A local Git 2.54 probe confirms that `git config
--name-only` canonicalizes section and key names to lowercase while retaining
subsection case, for example:

```text
core.hookspath
diff.Custom.textconv
```

A1 therefore uses lowercase fixed section/key components in its exact regex.
This closes an evasion in the original proposal without adding a command.

The original newline-delimited identity parser was also incompatible with a
valid top-level path containing a newline. A1 retains the affirmed identity
command but compares its raw stdout against an exact expected byte template
constructed from the already canonical paths. It never splits a path-valued
Git result on newline.

## 3. Exact current seams

### 3.1 Git and testing

- `packages/git/src/index.ts` contains only the CT-01 simulated
  `RepositorySnapshot` and `GitService` interface. It imports no process or
  filesystem module and has no real implementation.
- `packages/git/package.json` already depends on `@craftingtable/domain`, and
  its TypeScript project already references domain. A1 needs no dependency or
  manifest change.
- `packages/testing/src/fake-git-service.ts` implements the simulated seam.
  `FakeAgentBackend` consumes it only to add a fake branch label to a demo
  event. These files remain unchanged.
- The root Vitest configuration already includes
  `packages/*/src/**/*.test.ts` and aliases `@craftingtable/git` to source.

### 3.2 Server

- `apps/server/src/config.ts` has no Git or repository-root configuration.
- `apps/server/src/composition.ts` imports no Git package and starts the
  accepted CT-03 planning daemon without Git.
- `apps/server` is not changed by A1. No normal daemon import creates or probes
  an inspector. This is how A1 satisfies the operator's no-hard-startup-
  dependency decision.

### 3.3 Scope enforcement

`scripts/check-forbidden-scope.mjs` currently:

- rejects `node:child_process` in all non-test package/application source;
- treats `@craftingtable/git` as a non-production seam;
- permits wider capability only in tests/test support.

A1 will narrow the first rule, not remove it: `node:child_process` is allowed
only in `packages/git/src/command-runner.ts`. It remains forbidden everywhere
else in production, and `@craftingtable/git` remains forbidden from normal
server composition until A2 explicitly changes that boundary.

### 3.4 Documentation

Architecture, security, operations, ADR-007, and ADR-008 still describe the
Git seam as fake/deferred and all production process execution as forbidden.
A1 needs one new ADR plus precise amendments to the current-boundary and
quality-gate documents. It does not revise UI principles.

## 4. A1 dependency and authority direction

The corrected project direction after A1 is:

```text
@craftingtable/domain
          ↑
@craftingtable/git ──→ Node filesystem/process/crypto primitives
          ↑
@craftingtable/testing (legacy fake consumer only)

@craftingtable/server ──→ domain + contracts + planning + storage
                         (still no Git import in A1)
```

Within `@craftingtable/git`:

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
typed observation or typed failure
```

The Git package imports no Fastify, HTTP contracts, SQLite, storage,
workspace/user/role types, audit/event vocabulary, React, or testing fake.
The private runner is not a reusable shell service and is not exported from
the package entry point.

## 5. Exact target file tree and scope

Files marked `+` are new; files marked `~` are modified.

```text
~ README.md
~ CLAUDE.md
~ package.json

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

~ packages/git/src/index.ts
+ packages/git/src/types.ts
+ packages/git/src/configuration.ts
+ packages/git/src/environment.ts
+ packages/git/src/command-runner.ts
+ packages/git/src/path-policy.ts
+ packages/git/src/repository-inspector.ts
+ packages/git/src/comparison.ts
+ packages/git/src/test-support.ts
+ packages/git/src/configuration.test.ts
+ packages/git/src/command-runner.test.ts
+ packages/git/src/path-policy.test.ts
+ packages/git/src/repository-inspector.test.ts
+ packages/git/src/comparison.test.ts
```

Predicted implementation scope:

```text
27 changed/new files
approximately 2,800–4,200 lines including tests and documentation
one production authority file importing node:child_process
one runtime package
no server, domain, contract, storage, migration, or browser layer
```

This is well below the roughly-60-file split trigger, introduces one
reviewable authority, and has no schema/browser assurance domain. No further
decomposition is proposed. If focused review shows that A1 requires server
activation, a second process implementation, more than roughly 45 files, or a
durable-state concern, stop and propose a further split instead of expanding.

No dependency is added, so neither `pnpm-lock.yaml`, the Git package manifest,
nor its TypeScript project file should change.

## 6. Observational API

The package entry point continues exporting the legacy simulated CT-01 types
unchanged and adds only the high-level A1 interface, factory, observations,
comparison, options, and public error/result types.

Conceptual public API:

```ts
interface RepositoryInspector {
  inspect(request: RepositoryInspectionRequest): Promise<RepositoryInspectionResult>;
}

interface RepositoryInspectionRequest {
  readonly requestedPath: string;
  readonly signal?: AbortSignal;
}

type RepositoryInspectionResult =
  | { readonly ok: true; readonly observation: RepositoryObservation }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

async function createRepositoryInspector(
  options: RepositoryInspectorOptions,
): Promise<RepositoryInspectorCreationResult>;

function compareRepositoryObservations(
  recorded: RepositoryObservation,
  current: RepositoryObservation,
): RepositoryObservationComparison;
```

Creation is explicit and lazy. Importing the module performs no filesystem
access, executable lookup, version probe, or process spawn. The factory
validates options, roots, executable, and version only when a caller invokes
it. A1 adds no call site in the daemon.

Private package-only interfaces:

```ts
type FixedGitCommand =
  | { readonly kind: 'version'; readonly cwd: CanonicalPath }
  | { readonly kind: 'identity'; readonly cwd: CanonicalPath;
      readonly expectedTopLevel: CanonicalPath;
      readonly expectedGitDirectory: CanonicalPath }
  | { readonly kind: 'local-execution-feature-names';
      readonly cwd: CanonicalPath };

interface BoundedCommandRunner {
  run(command: FixedGitCommand, signal?: AbortSignal):
    Promise<PrivateCommandResult>;
}

interface RepositoryPathAdmission {
  admit(requestedPath: string): Promise<PathAdmissionResult>;
}
```

There is no public `run`, `spawn`, `command`, `argv`, `environment`, or
`GitInvocation` type. A2 cannot construct a `FixedGitCommand`; it can request
only an inspection.

## 7. Programmatic configuration and lazy executable resolution

`RepositoryInspectorOptions` contains only library configuration:

```ts
interface RepositoryInspectorOptions {
  readonly allowedSourceRoots: readonly string[];
  readonly dataRoot: string;
  readonly artifactRoot: string;
  readonly managedWorktreeRoot: string;
  readonly gitExecutable?: string;
  readonly executableSearchPath?: string;
  readonly timeoutMs?: number;
  readonly stdoutLimitBytes?: number;
  readonly stderrLimitBytes?: number;
  readonly terminationGraceMs?: number;
}
```

A1 does not parse `CRAFTINGTABLE_*` environment variables. Operator-facing
feature activation and a typed feature-unavailable result belong to A2.

Limits:

| Option | Default | Accepted range |
| --- | ---: | ---: |
| `allowedSourceRoots.length` | required | 1–32 |
| one UTF-8 path | n/a | 1–4096 bytes |
| `timeoutMs` | 5000 | 100–30000 |
| `stdoutLimitBytes` | 65536 | 1024–1048576 |
| `stderrLimitBytes` | 65536 | 1024–1048576 |
| `terminationGraceMs` | 250 | 50–2000 |
| observed config keys | n/a | at most 256 |
| observed hook entries | n/a | at most 256 |

If `gitExecutable` is supplied, it must be an absolute normalized path to a
regular executable. It is canonicalized with `realpath`. A relative value,
directory, missing file, or non-executable is rejected.

If it is omitted, the factory scans `executableSearchPath` or the caller
process's current `PATH`. Only absolute path entries are eligible; empty and
relative entries are skipped rather than interpreted against a current
directory. The first executable `git` is `realpath`-resolved and stored as an
absolute canonical path. The child never receives `PATH`.

The factory stores the executable's canonical path and inode/size/mtime
evidence. Each later invocation rechecks that the path still resolves to the
same regular executable; replacement yields `git-executable-changed` and
requires a new inspector. A device-ID-only change is reported as environmental
evidence and does not by itself claim that the binary content changed.

The version probe uses the first canonical allowed root as `cwd`, solely so it
never inherits an arbitrary daemon current directory.

## 8. Git version and the exact production command union

### 8.1 Version parsing and floor

The parser accepts a leading:

```text
git version <major>.<minor>[.<patch>]
```

and ignores legitimate trailing vendor content. Required examples:

```text
git version 2.54.0
git version 2.39.3 (Apple Git-146)
git version 2.45.0.windows.1
```

Empty output, a non-`git` prefix, integer overflow, version 1.x, and Git
2.31.x are rejected.

The minimum is Git 2.32.0. Capability history is recorded explicitly:

- 2.29 introduced `--show-object-format`;
- 2.31 introduced `--path-format=absolute`;
- 2.32 introduced `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, which the
  constructed environment relies on.

The 2.32 isolation control is the binding floor. Absence of `HOME` is defense
in depth, not the primary global-config control.

### 8.2 Exact commands

Version:

```text
<canonical-git> --version
```

Identity, with `cwd` equal to the admitted canonical requested path:

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

Local external-execution feature names, with the same `cwd`:

```text
<canonical-git> -c core.fsmonitor=false config \
  --local \
  --no-includes \
  --null \
  --name-only \
  --get-regexp \
  '^(extensions\.worktreeconfig|core\.hookspath|core\.fsmonitor|diff\.external|diff\..*\.(command|textconv)|filter\..*\.(clean|smudge|process)|include\.path|includeif\..*\.path)$'
```

These are the only production Git command variants in A1. The identity and
feature variants are each invoked once per inspection; version is invoked
once per inspector creation. User data never occupies an argv position.

Identity stdout is not line-split. After filesystem admission establishes
`top` and `gitDir`, the parser constructs the exact raw prefix
`<top>\n<gitDir>\n<gitDir>\n`, removes it only on a byte-for-byte match, and
then accepts only one of these exact tails:

```text
false\ntrue\nsha1\n
false\ntrue\nsha256\n
```

The complete bytes must match exactly. A structurally valid but different
object-format token is `unsupported-object-format`; any other tail is
`malformed-identity-output`. This simultaneously proves exact
top-level, primary Git/common directory, non-bare class, inside-work-tree, and
supported object format without confusing an embedded newline in either path
with field framing. No partial or extra output is accepted.

Feature stdout must be valid UTF-8 and a properly terminated NUL sequence.
Every name must match the fixed lowercase-section/key grammar above; no empty
or unmatched field is accepted. Exit 0 requires a valid sequence. Exit 1 with
both stdout and stderr empty means no matches. Every other outcome is failure.
Values and included files are never requested.

No A1 production command is `status`, `diff`, `show`, `show-ref`, `fetch`,
`clone`, `pull`, `push`, `checkout`, `branch`, `commit`, `worktree`, or a
remote operation.

## 9. Constructed process environment

Every A1 Git child receives a newly constructed object containing exactly:

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

The implementation never clones and scrubs `process.env`. Therefore the child
does not inherit:

```text
HOME
PATH
GIT_DIR
GIT_WORK_TREE
GIT_COMMON_DIR
GIT_INDEX_FILE
GIT_OBJECT_DIRECTORY
GIT_ALTERNATE_OBJECT_DIRECTORIES
GIT_NAMESPACE
GIT_CONFIG
GIT_CONFIG_COUNT
GIT_CONFIG_KEY_*
GIT_CONFIG_VALUE_*
GIT_EXEC_PATH
GIT_CEILING_DIRECTORIES
GIT_SSH
GIT_SSH_COMMAND
GIT_ASKPASS
SSH_ASKPASS
credential/proxy variables
trace variables
```

`HOME` is neither passed nor repurposed. The absolute executable removes the
child's need for `PATH`. The command uses `spawn` directly with `shell: false`,
stdin ignored/closed, and separate piped stdout/stderr.

## 10. Bounded process lifecycle

The runner:

1. validates the private command variant;
2. revalidates the executable;
3. constructs the fixed argv and environment;
4. starts a detached POSIX process group with no shell;
5. counts stdout/stderr bytes independently before concatenation;
6. settles exactly once on abort, error, overflow, deadline, signal, or close;
7. on abort/overflow/deadline sends `SIGTERM` to the process group, waits the
   configured grace period, then sends `SIGKILL` if needed;
8. awaits close before returning a classification;
9. discards partial output for all non-success classifications.

Timeout, stdout overflow, stderr overflow, caller abort, signal termination,
spawn failure, and ordinary nonzero exit are distinct. Overflow and timeout
take precedence over a later exit code. A caller cannot receive success after
any bound is crossed.

A public error never contains raw stdout, raw stderr, environment data,
repository config values, credentials, or an unbounded system error string.
The private runner retains bytes only within configured limits and only until
the parser/classifier finishes.

The supported process-control runtime for A1 is POSIX, matching the current
local deployment. Unsupported process-group semantics fail inspector creation
rather than silently weakening termination. A hard daemon kill can leave a
read-only child alive briefly; because A1 has no mutation command, closed
stdin, no terminal, no remote command, optional locks disabled, and no durable
intent, there is no state to reconcile on restart. Normal cancellation and
shutdown use the abort path.

The REG-GIT-004 prompt attempt is necessarily proved with a purpose-built
process proxy. None of A1's three accepted read-only commands naturally asks
for credentials. The proxy proves closed stdin, prompt variables, deadline,
and termination mechanics; real prompt surfaces first arrive in later
mutating slices and need their own real-command tests.

## 11. Root and path policy

### 11.1 Policy roots

Factory validation requires:

- 1–32 absolute, lexically normalized, existing source-root directories;
- no symlink component in a source root;
- `realpath(root) === root`;
- no source roots equal to or nested within one another;
- an absolute, normalized, existing, canonical, symlink-free data root;
- absolute normalized artifact and managed-worktree reserved paths that are
  strict descendants of the data root and disjoint from each other;
- every existing component of a reserved path is symlink-free and resolves as
  written;
- no source root overlaps the data-root subtree in either ancestor direction.

A1 treats artifact and managed-worktree values as reserved path names. It does
not create them. Since both must be below the data root and source roots must
be disjoint from the complete data subtree, registration cannot enter either
reserved area.

The more specific CT-04A binding decision controls the parent wording: a
repository must be strictly below exactly one source root, not equal to it.

### 11.2 Requested path admission

Admission order:

1. validate a string with 1–4096 UTF-8 bytes and no NUL;
2. require absolute and already lexically normalized input;
3. find exactly one source root that strictly contains it by path-component
   comparison, not string prefix;
4. reject data/artifact/managed-root equality or overlap defensively;
5. `lstat` every component from the filesystem root through the requested
   directory and reject every symlink;
6. require an existing directory and `realpath(request) === request`;
7. require `<request>/.git` to be an actual directory, not a symlink or file;
8. reject any `.git/commondir` entry and any symlinked `.git/config`; inspect
   `.git/hooks` with `lstat`, recording a hooks-directory symlink as risk
   without following it;
9. require requested top-level and `.git` ownership by the daemon's effective
   UID;
10. run the fixed identity command and require the exact raw template;
11. collect bigint stat evidence for top-level and common Git directory;
12. inspect feature keys and hooks;
13. repeat realpath/lstat/stat for top-level, `.git`, config, and hooks and
   reject if the observation raced a path/layout replacement.

Step 7 rejects non-Git directories, arbitrary repository subdirectories, bare
repositories, linked worktrees, submodule checkouts, and separate-git-dir
layouts before they can be accepted. Step 10 proves the directory is the exact
Git top-level with `.git` as both Git directory and common directory.

Paths with spaces, leading-dash basenames, shell metacharacters, tabs, or
newlines are legal if every structural rule passes. They are passed only as
the `cwd` option to `spawn`, never to a shell or argv.

### 11.3 Ownership refusal

A1 supports repositories owned by the daemon's effective UID. It offers no
`safe.directory` escape hatch. A top-level/common-directory UID mismatch is
`ownership-refused` before Git. If Git nevertheless returns the stable
C-locale dubious-ownership diagnostic, the classifier maps it to the same
typed error. The public result contains a canned actionable message and
bounded numeric expected/observed UID evidence, never raw stderr.

This is an admission policy, not a claim that the operator cannot modify an
owned repository concurrently. A1 does not claim sandboxing against a
malicious local owner, root, or mount administrator.

The postflight detects path/layout and inode replacement, not a same-inode
config or hook-content edit racing the scan. External-execution evidence is a
timestamped point observation. A2 repeats the complete inspection immediately
before storage, and later mutation must re-inspect; a malicious concurrent
local owner remains outside the trust claim.

## 12. Repository observation and comparison

### 12.1 Observation

Conceptual result:

```ts
interface RepositoryObservation {
  readonly observationVersion: 1;
  readonly inspectionPolicyVersion: 1;
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
  readonly externalExecution: ExternalExecutionObservation;
}
```

Bigint filesystem values cross the interface as canonical unsigned decimal
strings. The versioned fingerprint is SHA-256 over an unambiguous
length-prefixed encoding of:

```text
canonical top-level
canonical common Git directory
object format
top-level inode
common-directory inode
```

Device IDs are deliberately excluded. A1 cannot know whether a future remount
will change them, and it makes no startup stability claim.

The observation has no workspace, user, repository ID, status, policy,
registration, retirement, or binding field.

### 12.2 External-execution observation

```ts
interface ExternalExecutionObservation {
  readonly classification: 'none-observed' | 'risk-observed';
  readonly signals: readonly ExternalExecutionSignal[];
}
```

Signals are sorted and unique and use a closed vocabulary:

```text
core-hooks-path
core-fsmonitor
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

For driver/filter subsections and hooks, A1 may return a bounded name alongside
the category. It never reads config values or hook content. More than 256
matched keys or hook entries is a typed bound failure, not a truncated
`none-observed` result.

`extensions.worktreeconfig` is itself `risk-observed`. A1 deliberately does
not add a fourth `config --worktree` command. It also does not enumerate:

- `.git/config.worktree` contents after the extension signal;
- submodule `.git/modules/*/config`;
- `.gitattributes` or `.git/info/attributes`;
- hook contents;
- config include targets or values.

These surfaces cannot cause external execution in the accepted A1 command
set: hooks are not triggered; diff/textconv/filter commands are not invoked;
fsmonitor is overridden with `-c core.fsmonitor=false`; includes may supply
configuration but cannot introduce a new subcommand; no submodule, object,
checkout, diff, or remote operation occurs. The observation is therefore
honest but not a future mutation authorization. A later mutating slice must
perform a newly reviewed execution-surface inspection.

### 12.3 Field-level comparison

`compareRepositoryObservations` is pure and returns sorted differences:

```ts
interface RepositoryObservationComparison {
  readonly coreDifferences: readonly CoreEvidenceDifference[];
  readonly environmentalDifferences: readonly EnvironmentalEvidenceDifference[];
  readonly externalExecutionDifferences:
    readonly ExternalExecutionDifference[];
  readonly sameCoreIdentity: boolean;
  readonly sameEnvironmentalEvidence: boolean;
  readonly sameExternalExecutionEvidence: boolean;
}
```

Core fields are canonical top-level, canonical Git/common directories, object
format, and both inodes. Environmental fields are both device IDs. External
feature signals are a third independent comparison tier.

A1 does not return `active`, `unavailable`, `identity-evidence-changed`,
`identity-mismatch`, `blocked`, `reaffirmed`, or `retired`. A2 maps:

- a typed path/unavailability failure;
- core differences;
- device-only differences;
- feature differences;

to durable application semantics according to the accepted operator
disposition.

## 13. Typed failure taxonomy

Expected creation and inspection failures are data, not raw thrown subprocess
errors:

| Category | Codes |
| --- | --- |
| configuration | `invalid-options`, `unsupported-platform`, `invalid-root-policy` |
| executable | `git-not-found`, `git-not-executable`, `git-executable-changed`, `unsupported-git-version` |
| path | `invalid-path`, `outside-allowed-root`, `excluded-root-overlap`, `path-unavailable`, `symlink-rejected` |
| ownership | `ownership-refused` |
| repository class | `not-primary-repository`, `not-git-repository`, `unsupported-object-format` |
| process | `spawn-failed`, `aborted`, `timed-out`, `stdout-overflow`, `stderr-overflow`, `signal-terminated`, `git-command-failed` |
| output | `invalid-output-encoding`, `malformed-version-output`, `malformed-identity-output`, `malformed-feature-output`, `feature-count-exceeded` |
| observation | `observation-raced` |

Each public error contains only:

```text
category
code
operation: create | version | identity | feature-scan | filesystem
retryability: retryable | configuration-required | not-retryable
fixed message
bounded structured evidence from an allowlist
```

Allowed evidence is limited to configured numeric bounds, fixed command kind,
exit code, signal name, Git version tuple, numeric UID, and a fixed path-policy
reason. It excludes requested/canonical paths by default, raw process output,
config names/values, environment, credentials, and arbitrary `Error.message`.
A2 owns any operator-visible path disclosure and HTTP mapping.

Unexpected programmer invariant failures may reject the promise, but tests
prove every filesystem, Git, cancellation, process, and parse outcome in the
declared taxonomy is converted to the union.

## 14. A1 adversarial matrices

Every row below is a permanent proof obligation, not an example.

### 14.1 Configuration and executable matrix

| ID | Case | Expected | Permanent proof |
| --- | --- | --- | --- |
| A1-CFG-001 | import package without creating inspector | no fs lookup or spawn | `configuration.test.ts` |
| A1-CFG-002 | valid explicit absolute executable | canonical executable accepted and versioned | `configuration.test.ts` |
| A1-CFG-003 | relative/missing/directory/non-executable executable | typed creation failure | `configuration.test.ts` |
| A1-CFG-004 | omitted executable with mixed absolute/relative PATH entries | only absolute entries searched; absolute result stored | `configuration.test.ts` |
| A1-CFG-005 | no eligible Git | `git-not-found`; caller daemon unaffected because factory was explicit | `configuration.test.ts` |
| A1-CFG-006 | plain/Apple/Windows version strings | leading semantic tuple accepted | `configuration.test.ts` |
| A1-CFG-007 | malformed/empty/non-Git/overflow version strings | malformed or unsupported result | `configuration.test.ts` |
| A1-CFG-008 | Git 2.31.1 | rejected; floor is 2.32.0 | `configuration.test.ts` |
| A1-CFG-009 | exact min/max process limits | accepted | `configuration.test.ts` |
| A1-CFG-010 | below/above/noninteger limits | `invalid-options` | `configuration.test.ts` |
| A1-CFG-011 | executable replaced after creation | `git-executable-changed`; no spawn of replacement | `configuration.test.ts` |
| A1-CFG-012 | unsupported process-group platform | typed creation failure, not weakened termination | `configuration.test.ts` |

### 14.2 Root and requested-path matrix

| ID | Case | Expected | Permanent proof |
| --- | --- | --- | --- |
| A1-PATH-001 | one canonical source root and disjoint reserved paths | policy accepted | `path-policy.test.ts` |
| A1-PATH-002 | no roots or more than 32 | configuration rejected | `path-policy.test.ts` |
| A1-PATH-003 | relative/non-normalized/missing/non-directory source root | configuration rejected | `path-policy.test.ts` |
| A1-PATH-004 | symlink at source-root/intermediate component | configuration rejected | `path-policy.test.ts` |
| A1-PATH-005 | duplicate/nested/ancestor source roots | configuration rejected | `path-policy.test.ts` |
| A1-PATH-006 | source root equals/contains/is below data root | configuration rejected in both directions | `path-policy.test.ts` |
| A1-PATH-007 | artifact/worktree path outside data, equal data, or overlapping each other | configuration rejected | `path-policy.test.ts` |
| A1-PATH-008 | nonexisting reserved suffix below canonical data | accepted without directory creation | `path-policy.test.ts` |
| A1-PATH-009 | canonical exact primary repository strictly below one root | admitted | `repository-inspector.test.ts` |
| A1-PATH-010 | requested path equals allowed root | rejected by slice-specific strict-below rule | `path-policy.test.ts` |
| A1-PATH-011 | relative, empty, NUL, oversized, or non-normalized request | rejected before Git | `path-policy.test.ts` |
| A1-PATH-012 | missing path or nondirectory | `path-unavailable`; zero Git calls | `path-policy.test.ts` |
| A1-PATH-013 | outside all roots or component-prefix lookalike | rejected | `path-policy.test.ts` |
| A1-PATH-014 | path overlaps data/artifact/worktree exclusion | rejected | `path-policy.test.ts` |
| A1-PATH-015 | symlink at each requested component or final component | rejected without following | `path-policy.test.ts` |
| A1-PATH-016 | repository subdirectory | `not-primary-repository` | `repository-inspector.test.ts` |
| A1-PATH-017 | bare repository | rejected as non-primary | `repository-inspector.test.ts` |
| A1-PATH-018 | linked worktree or submodule `.git` file | rejected as non-primary | `repository-inspector.test.ts` |
| A1-PATH-019 | separate Git directory or `.git/commondir` indirection | rejected as non-primary | `repository-inspector.test.ts` |
| A1-PATH-020 | `.git` or config symlink; hooks-directory symlink | `.git`/config rejected; hooks symlink is risk-observed without following | `repository-inspector.test.ts` |
| A1-PATH-021 | shell metacharacters, leading dash, spaces, tab, newline | accepted when otherwise valid; appears only as one `cwd` | `repository-inspector.test.ts` |
| A1-PATH-022 | path swapped between admission phases | `observation-raced`; no observation returned | `repository-inspector.test.ts` |
| A1-PATH-023 | top-level or common directory owned by different UID | `ownership-refused`; zero config/hook execution | `repository-inspector.test.ts` |
| A1-PATH-024 | Git emits dubious-ownership diagnostic despite precheck | typed `ownership-refused`, no raw stderr | `command-runner.test.ts` |

### 14.3 Fixed command and process matrix

| ID | Case | Expected | Permanent proof |
| --- | --- | --- | --- |
| A1-GIT-001 | each closed command kind | exact executable/argv/cwd/env; structured bounded result | `command-runner.test.ts` |
| A1-GIT-002 | user path starts with dash/metacharacters/newline | cannot select command or option; only `cwd` | `command-runner.test.ts` |
| A1-GIT-003 | inherited Git dir/worktree/index/object/config overrides | none present in child | `command-runner.test.ts` |
| A1-GIT-004 | inherited HOME/PATH/askpass/SSH/proxy/trace | none present in child | `command-runner.test.ts` |
| A1-GIT-005 | hostile global `~/.gitconfig` and inherited global config override | `/dev/null` controls; local scan sees no global keys; marker not executed | `command-runner.test.ts` |
| A1-GIT-006 | prompt proxy tries to read stdin | EOF, prompt disabled, bounded failure | `command-runner.test.ts` |
| A1-GIT-007 | stdout exactly at limit | accepted if otherwise valid | `command-runner.test.ts` |
| A1-GIT-008 | stdout one byte above limit | terminate group; `stdout-overflow`; no partial success | `command-runner.test.ts` |
| A1-GIT-009 | stderr exactly at limit | process outcome classified normally | `command-runner.test.ts` |
| A1-GIT-010 | stderr one byte above limit | terminate group; `stderr-overflow` | `command-runner.test.ts` |
| A1-GIT-011 | deadline expires | TERM then KILL as needed; `timed-out` | `command-runner.test.ts` |
| A1-GIT-012 | caller abort | TERM then KILL as needed; `aborted` | `command-runner.test.ts` |
| A1-GIT-013 | process ignores TERM or creates a child | whole proxy process group is killed after grace | `command-runner.test.ts` |
| A1-GIT-014 | spawn error | bounded `spawn-failed`; settle once | `command-runner.test.ts` |
| A1-GIT-015 | signal exit | `signal-terminated` | `command-runner.test.ts` |
| A1-GIT-016 | nonzero ordinary exit | `git-command-failed`, except exact classified ownership refusal | `command-runner.test.ts` |
| A1-GIT-017 | overflow/deadline races process close | first terminal failure dominates; no double settlement | `command-runner.test.ts` |
| A1-GIT-018 | success followed by extra output/bytes | parser rejects; never partial interpretation | `command-runner.test.ts` |
| A1-GIT-019 | production source imports process elsewhere | scope gate fails | `check-forbidden-scope.test.mjs` |
| A1-GIT-020 | package entry point inspected | no raw runner/command/argv/environment export | `command-runner.test.ts` and typecheck |

### 14.4 Output and evidence matrix

| ID | Case | Expected | Permanent proof |
| --- | --- | --- | --- |
| A1-EVID-001 | real SHA-1 primary repository | exact paths, booleans, format, inode/device evidence | `repository-inspector.test.ts` |
| A1-EVID-002 | SHA-256 repository | accepted when installed Git supports fixture; synthetic parser proof is mandatory | `repository-inspector.test.ts` |
| A1-EVID-003 | path-valued stdout includes embedded newline | raw expected-template comparison succeeds without line splitting | `repository-inspector.test.ts` |
| A1-EVID-004 | wrong top, Git dir, common dir, booleans, format, missing/extra newline | `malformed-identity-output` | `repository-inspector.test.ts` |
| A1-EVID-005 | invalid UTF-8 version or feature output | `invalid-output-encoding` | `command-runner.test.ts` |
| A1-EVID-006 | feature exit 1 with empty streams | empty `none-observed` result | `repository-inspector.test.ts` |
| A1-EVID-007 | feature exit 1 with output or other nonzero | failure, not empty evidence | `repository-inspector.test.ts` |
| A1-EVID-008 | malformed/nonterminated/empty NUL feature field | `malformed-feature-output` | `repository-inspector.test.ts` |
| A1-EVID-009 | more than 256 keys or hook entries | bound failure, not incomplete clean claim | `repository-inspector.test.ts` |
| A1-EVID-010 | each filter/fsmonitor/diff/textconv/hooks/include signal | sorted typed `risk-observed`; no value/content read | `repository-inspector.test.ts` |
| A1-EVID-011 | `extensions.worktreeConfig=true`, feature only in config.worktree | `worktree-config-enabled` risk from local extension key | `repository-inspector.test.ts` |
| A1-EVID-012 | no matched key and only sample hooks | `none-observed` | `repository-inspector.test.ts` |
| A1-EVID-013 | non-sample hook file/dir/symlink | typed risk; no execution/follow/content read | `repository-inspector.test.ts` |
| A1-EVID-014 | attributes or submodule config contains driver-looking text | not falsely enumerated; limitation explicit; no A1 command activates it | `repository-inspector.test.ts` |
| A1-EVID-015 | identical observations | all comparison arrays empty | `comparison.test.ts` |
| A1-EVID-016 | canonical top/common/Git dir, object format, or inode changes individually | named core difference | `comparison.test.ts` |
| A1-EVID-017 | only one/both device IDs change | environmental differences only; core identity unchanged | `comparison.test.ts` |
| A1-EVID-018 | feature signal added/removed | external-execution difference only | `comparison.test.ts` |
| A1-EVID-019 | fingerprint construction ambiguous-looking field boundaries | length prefix produces distinct digest | `comparison.test.ts` |
| A1-EVID-020 | current path unavailable | typed inspection failure; comparison does not invent a durable state | `repository-inspector.test.ts` |
| A1-EVID-021 | hard daemon death with read-only child outstanding | no repository-side mutation/durable intent/reconciliation hook | documented invariant plus command-surface test |

### 14.5 Boundary matrix

| ID | Case | Expected | Permanent proof |
| --- | --- | --- | --- |
| A1-BND-001 | start accepted CT-03 daemon without Git roots | unchanged startup; A1 has no server import | scope test plus full `pnpm check` |
| A1-BND-002 | import `@craftingtable/git` only | no process or filesystem side effect | `configuration.test.ts` |
| A1-BND-003 | inspect package dependency graph | Git owns process; no storage/server/browser dependency | scope test and TypeScript project graph |
| A1-BND-004 | scan production commands | exactly version, identity, local-feature names | `command-runner.test.ts` |
| A1-BND-005 | inspect repository after test | no repository-side file/directory/ref/content change | `repository-inspector.test.ts` |
| A1-BND-006 | search route/schema/event/browser changes | none in A1 target diff | scope review and `git diff --name-only` |

## 15. Parent protected and acceptance proof map

The protected specification still names the parent slice `CT-04A`. A1 supplies
protected-equivalent proof for the observational portion; A2 must compose and
run the original expected outcomes. A1 does not relabel, weaken, or claim
completion of a parent case.

### 15.1 Path cases

| Parent ID | A1 permanent contribution | Required A2 completion |
| --- | --- | --- |
| REG-PATH-001 | A1-PATH-009/EVID-001 prove a valid canonical primary observation | Owner authorization, durable registration, uniqueness |
| REG-PATH-002 | none; A1 has no roles/caller | 403 and zero inspector call |
| REG-PATH-003 | A1-PATH-011 | service maps failure before Git/state |
| REG-PATH-004 | A1-PATH-012 | no row/audit success/event/notifier |
| REG-PATH-005 | A1-PATH-013 | service failure mapping |
| REG-PATH-006 | A1-PATH-016 | service failure mapping |
| REG-PATH-007 | A1-PATH-017 | service failure mapping |
| REG-PATH-008 | A1-PATH-018 | service failure mapping |
| REG-PATH-009 | A1-PATH-006/014 | A2 supplies configured reserved path names lazily |
| REG-PATH-010 | A1-PATH-006/014 | A2 supplies canonical data/artifact roots lazily |
| REG-PATH-011 | A1-PATH-004/015/020 prove the exact reject policy | service failure mapping |
| REG-PATH-012 | A1-PATH-021 and A1-EVID-003 | A2 strict request/display-name behavior |

### 15.2 Identity/evidence cases

| Parent ID | A1 permanent contribution | Required A2 completion |
| --- | --- | --- |
| REG-ID-001 | A1-EVID-015 proves a field-level match | store/append verification evidence |
| REG-ID-002 | A1-PATH-022 and A1-EVID-016 expose replacement differences | block and record durable mismatch |
| REG-ID-003 | none; no workspace/schema in A1 | global structural uniqueness and service non-disclosure |
| REG-ID-004 | none; no registry in A1 | same-workspace idempotency |
| REG-ID-005 | A1-EVID-020 returns unavailable failure without semantics | durable unavailable state, not retirement |
| REG-ID-006 | A1-EVID-004/016 expose common-directory delta | durable core-mismatch policy |
| REG-ID-007 | A1-EVID-016/017 distinguish inode from dev-only delta | evidence-changed/reaffirmation versus mismatch |
| REG-ID-008 | A1-EVID-009–014 return bounded external-execution evidence | append evidence and block later mutation per policy |

### 15.3 Git process cases

| Parent ID | A1 permanent contribution | Required A2 completion |
| --- | --- | --- |
| REG-GIT-001 | A1-GIT-001 and real inspector proof | invoke only through high-level inspector |
| REG-GIT-002 | A1-GIT-002/PATH-021 | no public path-to-argv carrier |
| REG-GIT-003 | A1-GIT-003–005 | use accepted inspector unchanged |
| REG-GIT-004 | A1-GIT-006/011/013 proxy, with limitation stated | later mutating slices add real prompt-surface proof |
| REG-GIT-005 | A1-GIT-007/008/017 | no state on overflow |
| REG-GIT-006 | A1-GIT-009/010/017 | no state on overflow |
| REG-GIT-007 | A1-GIT-011/017 | no state on timeout |
| REG-GIT-008 | A1-GIT-020 proves no raw package API | A2 strict HTTP request rejects command/argv/env |

### 15.4 Parent cases deliberately assigned to A2

| Parent cases | A1 boundary | A2 obligation |
| --- | --- | --- |
| OWN-REP-001..006 | no workspace/project/user/domain IDs | full service and structural ownership matrix |
| JRN-REP-001..005 | no transaction/audit/event/notifier | atomic journals, correlation, replay, disclosure |
| A-API-001 | no public HTTP contract | strict registration request |
| A-MIG-001 | no migration | schema-2 preservation and migration 0003 |
| A-NOTIFY-001 | no notifier | post-commit wake before fallback |
| A-ROLE-001 | no authorization | Owner/Editor/Viewer behavior before A1 call |
| A-DOC-001 | A1 corrects active planning references and assessment drift | A2 records composed parent feature |

Process cases:

- P-PROCESS-001: the eventual A1 accepted plan must be committed before the
  first A1 code commit; the parent remains incomplete until A2.
- P-PROCESS-002: this proposal receives a fresh independent A1 design review
  and operator disposition.
- P-PROCESS-003: A1 completion records only the real stable A1 implementation
  head; the parent completion later records the composed head.
- P-PROCESS-004: A1 installs and exercises the correct protected-package pin
  and literal hashes below.

## 16. Real Git fixtures and process-fault proxies

Real fixtures live under unique temporary directories and have no network
access. Test-only setup may invoke:

```text
git init --initial-branch=main <absolute-temp-path>
git -C <path> -c user.name=CraftingTable \
  -c user.email=craftingtable.invalid add --all
git -C <path> -c user.name=CraftingTable \
  -c user.email=craftingtable.invalid commit --no-gpg-sign -m initial
git init --bare <absolute-temp-path>
git -C <primary> worktree add --detach <absolute-temp-path> HEAD
git init --separate-git-dir=<absolute-temp-path> <absolute-temp-path>
git -C <path> config --local <fixed-test-key> <fixed-test-value>
git -C <path> config --worktree <fixed-test-key> <fixed-test-value>
```

These commands are test-fixture construction only and are not members of the
production `FixedGitCommand` union. Test setup uses argument arrays and fresh
temporary paths.

Fixtures cover:

- ordinary SHA-1 primary repository;
- SHA-256 when installed Git supports it, plus mandatory synthetic framing;
- bare, linked-worktree, submodule-style, separate-Git-dir, subdirectory, and
  nested-primary layouts;
- symlink at every relevant component and internal metadata seam;
- leading-dash, spaces, metacharacters, tab, and newline in the top-level name;
- every local execution-feature key category, mixed-case subsection names,
  worktree config extension, sample/non-sample hooks, hook symlink, attributes,
  and submodule config;
- path disappearance and replacement during inspection;
- injectable stat snapshots for inode-only and dev-only changes.

The ownership test attempts a real UID mismatch only when the host can create
one safely and is not running as root. Otherwise a deterministic injected stat
provider plus a fake Git dubious-ownership response is mandatory; the test is
not silently skipped without the deterministic proof.

Purpose-built executable proxies are generated under temporary directories for
version variants, environment capture, prompt/EOF, malformed bytes, nonzero
exit, signal, overflow, hang, TERM refusal, child-process-group termination,
and racing terminal events. A proxy has the actual `process.execPath` in its
shebang so it does not require child `PATH`; each proxy embeds one behavior so
no test-only environment variable weakens the production constructed
environment.

Tests compare repository metadata and refs before/after A1 inspection to prove
the production command surface is observational.

## 17. Protected-package verification

A1 adds a deterministic development-only verifier with:

- protected-package pin
  `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`;
- exact two-file manifest;
- the two literal SHA-256 values from section 2;
- rejection of a missing, extra, or changed protected file.

The root gate adds:

```text
git diff --exit-code 06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4 -- protected/
node scripts/check-ct04-protected-package.mjs
```

The script uses filesystem hashing only; the fixed Git comparison is
development tooling in `package.json`, not a production Git execution path.
The verifier test copies the package to a temporary directory, changes one
`expected:` line, and proves rejection. It separately proves rejection of an
extra file. This is the required negative probe; a checker that always passes
will fail its own test.

The protected files themselves are never edited.

## 18. Documentation and ADR plan

- ADR-016 records the fixed command union, lazy creation, executable/version
  policy, constructed environment, bounds/termination, path/UID trust,
  external-feature observation boundary, and A2 separation.
- ADR-008 is amended so `check:scope` allows `node:child_process` only in the
  one reviewed A1 production file and records the protected-package gate.
- `docs/architecture.md` adds `git -> domain + Node primitives`, preserves
  server non-composition, and redraws the graph without duplicate server
  nodes.
- `docs/security.md` records no-shell/no-remote controls, path and ownership
  rejection, local-operator trust, raw diagnostic suppression, and known
  feature-enumeration limits.
- `docs/operations.md` records Git 2.32/POSIX as A1 test/library requirements,
  states that no repository environment setting is activated yet, and states
  that planning-only daemon startup remains unchanged.
- `README.md` and `CLAUDE.md` identify accepted CT-03 as the current composed
  runtime and CT-04A1 as the active implementation slice; they do not claim
  that repository registration is available.

## 19. Deterministic verification proposed for A1 implementation

Only commands actually executed will appear in a future completion report.
The proposed deterministic gate is:

```text
corepack pnpm install --frozen-lockfile
pnpm check
pnpm exec vitest run packages/git/src
pnpm exec vitest run scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.test.mjs
node scripts/check-forbidden-scope.mjs
git diff --exit-code 06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4 -- protected/
node scripts/check-ct04-protected-package.mjs
sha256sum protected/README.md \
  protected/CT-04-protected-acceptance-spec.yaml
git status --short
```

`pnpm check` will include the protected-package command through `package.json`;
the repeated explicit commands provide review-visible slice evidence. The
real-Git fixtures run inside the Git-package test command. Full CT-01 through
CT-03 tests and E2E remain part of `pnpm check`.

## 20. Explicit A2 handoff

A2 must plan against the accepted A1 source, not this proposed interface.
Subject to A1 review, the intended seam is:

```text
A2 service
  authorizes active workspace membership and role
  supplies explicit root/executable/bound options lazily
  calls RepositoryInspector.inspect
  calls compareRepositoryObservations
  maps typed observations/failures to durable application semantics
```

Binding handoff rules:

1. A2 must authorize before calling A1; A1 has no workspace or role context.
2. A2 must preserve planning-only daemon startup when the feature is
   unconfigured. It creates/memoizes the inspector only for an authorized
   repository operation and exposes a typed feature-unavailable result.
3. Registration performs two complete A1 inspections, with the second
   immediately before the durable transaction, and requires compatible
   observations. A1's internal postflight check does not replace that rule.
4. A2 stores immutable inspection evidence and exposes its age. It does not
   call a raw command runner or parse Git output.
5. A2 maps core, environmental-device-only, and feature differences
   separately. In particular, device-only change is not terminal identity.
6. A2 owns Owner reaffirmation, terminal mismatch, unavailable, retirement,
   registration uniqueness, display name, and binding semantics.
7. A2 owns `repository_inspections`, migration 0003, the workspace-event
   rebuild/correlation, audit outcomes, notifier ordering, public contracts,
   routes, authorization, and browser event projection.
8. A2 may not import `node:child_process`, construct Git argv/environment,
   duplicate path admission, or add a second Git execution path.
9. A later mutating slice must extend or replace feature inspection through a
   new reviewed A1-style command-policy change; the A1 risk observation is not
   mutation authorization.
10. The full original parent protected suite runs only after A1+A2 integration.

Decisions already binding on future A2, without designing its schema here:

- device IDs are environmental evidence; explicit Owner reaffirmation
  preserves repository ID and bindings;
- repository retirement remains and has full proof;
- explicit Owner/Editor binding retirement remains;
- workspace events gain structural repository correlation by table rebuild;
- one `repository.register` audit action uses success/denied/failed outcomes;
- immutable append-only inspection evidence is not named mutable policy;
- active-membership/role checks precede host access;
- no automatic startup reconciliation;
- one repository may bind to multiple same-workspace projects.

If A2's fresh plan crosses the threshold, it must propose A2/A3 rather than
pulling durable or browser work back into A1.

## 21. Explicit exclusions

A1 creates:

- no SQLite migration or schema;
- no repository, inspection, policy, or binding row;
- no domain repository ID or record;
- no public HTTP or SSE contract;
- no route or service;
- no authorization or role behavior;
- no audit entry;
- no workspace-event kind or journal entry;
- no notifier call;
- no server startup dependency;
- no browser projection, activity, route, view, or behavior.

A1 also implements no repository mutation, change request, target-ref
resolution, branch, checkout, commit, worktree, status, diff, artifact, agent,
arbitrary process, remote Git, credential helper, verification, review,
readiness, merge, Exo Stack runtime dependency, or hosted-provider behavior.

It creates no file or directory in an inspected repository. The only
production child process is the private bounded local Git runner executing the
three fixed read-only variants in section 8.

## 22. Finding-reconciliation appendix

### 22.1 Findings assigned to A1

| Finding | Operator disposition | A1 reconciliation | Proof |
| --- | --- | --- | --- |
| F-01 | accepted | separate baseline/protected pins; literal two-file manifest; correct `06abcff` diff; negative scratch mutation/extra-file probes | section 2/17; protected verifier tests |
| F-03 | accepted | Git floor 2.32; capability history; HOME only defense in depth; 2.31 rejected; global config isolation | sections 8/9; A1-CFG-006–008, A1-GIT-005 |
| F-04 A1 portion | accepted with modification | core path/object/inode evidence separated from environmental device IDs; field-level differences only; no durable states | section 12; A1-EVID-015–019 |
| F-08 | accepted with modification | lowercase `extensions.worktreeconfig` included in the local scan; presence restrictive; intentionally unenumerated surfaces documented; no fourth command | sections 2/8/12; A1-EVID-010–014 |
| F-09 | accepted | effective-UID policy; no safe-directory override; precheck plus bounded Git diagnostic classification; real/proxy proof | sections 11/13/16; A1-PATH-023/024 |
| F-17 | accepted with modification | A1/A2 split honored; 27-file, one-authority A1; no schema/browser/server activation | sections 1/5/20/21 |
| F-18 | accepted with modification | no server changes; module import inert; explicit factory only; operator env activation deferred | sections 3/6/7; A1-CFG-001/005, A1-BND-001/002 |
| F-21 | accepted | vendor-tolerant leading version parser; prompt proxy limitation explicit | sections 8/10; A1-CFG-006–008, A1-GIT-006 |
| F-22 | accepted | corrected dependency graph; README-at-baseline discrepancy recorded; only current verified claims retained | sections 2/4 |

### 22.2 Findings assigned to A2

| Finding | A1 disposition / handoff |
| --- | --- |
| F-02 | no event kinds or browser changes in A1; exhaustive storage/browser projections required in A2 |
| F-05 | retirement retained wholly in A2 with a named acceptance group |
| F-06 | binding-retired event and per-project invalidation wholly in A2 |
| F-07 | migration-0003 workspace-event rebuild and structural repository correlation wholly in A2 |
| F-10 | same/foreign-workspace duplicate service semantics wholly in A2 |
| F-11 | A1 returns fresh observations; A2 appends immutable `repository_inspections`; mutable policy deferred |
| F-12 | durable version/transition/concurrency rules wholly in A2 |
| F-13 | membership existence versus active role is an A2 service/storage boundary |
| F-14 | explicit binding retirement wholly in A2 |
| F-15 | A1 supplies `observedAt`; A2 stores latest immutable verification evidence and exposes age |
| F-16 | registration denial/failure/success audit outcomes wholly in A2 |
| F-19 | durable state-machine and direct-SQL matrix wholly in A2 |
| F-20 | display-name rules wholly in A2; A1 accepts no display name |

### 22.3 Unified-plan strengths retained

The following reviewed choices survive without weakening:

- closed command variants rather than caller-provided argv;
- constructed rather than inherited-and-scrubbed environment;
- no shell;
- independent output bounds and a deadline;
- termination with no partial success;
- exact primary-checkout and symlink policy;
- repeated A1 observation before A2 durability;
- no remote Git;
- known external-execution observation;
- real temporary Git fixtures plus narrow deterministic fault proxies.

### 22.4 New reconciliation findings

Fresh A1 inspection added two corrections not called out by the review:

1. Git config key output uses lowercase section/key components, so the
   original mixed-case regex could miss `core.hookspath` and
   `extensions.worktreeconfig`.
2. newline-splitting identity output contradicts REG-PATH-012; exact expected
   raw-byte templates preserve both the fixed command and newline-safe paths.

Both are included in the focused review scope and permanent proof matrix.

## 23. Stop condition

After saving this proposal, stop for focused independent A1 design review and
operator adjudication. Do not create
`CT-04A1-accepted-implementation-plan.md`, do not modify production code, and
do not begin A2 planning or implementation.
