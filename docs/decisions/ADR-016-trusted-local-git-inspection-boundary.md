# ADR-016 — Trusted local Git inspection boundary

- **Status:** accepted
- **Date:** 2026-07-26
- **Amended:** 2026-07-26 after CT-04A1 initial review

## Context

CT-04 needs repository identity evidence before any durable registry,
worktree, or change-request authority exists. Host paths, repository-local Git
configuration, inherited daemon environment, executable replacement, output
volume, and process lifetime are all trust boundaries. A general Git wrapper or
public argv carrier would quietly authorize later mutation and remote access.

The independently reviewed CT-04A design was therefore split. CT-04A1 owns
observation only; CT-04A2 will own authorization, durable registration, and
project binding.

## Decision

`@craftingtable/git` exposes a lazy `RepositoryInspector`, a total parser for
recorded observations, and a comparison function. It is not composed into the
daemon in A1.

The inspector:

- accepts explicit source roots, optional reserved roots, executable policy,
  deadlines, stream bounds, and termination grace;
- requires non-root POSIX execution and Git 2.32.0 or newer;
- admits only canonical, symlink-free, exact primary checkouts owned by the
  daemon effective UID;
- rejects bare repositories, subdirectories, linked worktrees, separate Git
  directories, common-directory redirection, and structural replacement;
- stores one canonical executable and revalidates its path, device, inode,
  size, and mtime before every spawn.

An explicit executable is the only candidate considered. Search-path
resolution is first-viable rather than first-match: candidates are considered
in order and accepted only after canonical executable evidence and a successful
Git 2.32-or-newer version probe. If none is viable, the first probe failure is
retained.

The private process boundary has a closed three-variant command union:

1. `<git> --version`;
2. fixed `rev-parse` identity fields;
3. fixed `config --local --no-includes --null --name-only --get-regexp`
   risk-signal names.

It uses argument arrays and `shell: false`. Every child receives a newly
constructed ten-field locale/prompt/pager/lock/config environment; repository
commands add only `GIT_CEILING_DIRECTORIES` set to the canonical request
parent. Because POSIX Git parses that variable as a colon-delimited list with
no literal-colon escape, admission rejects a request whose parent contains a
colon before any repository spawn. A colon in the repository basename remains
valid when the parent is unambiguous. Stdin is closed. Stdout and stderr have
independent byte bounds.
Per-command and total inspection deadlines terminate the detached process
group with TERM then KILL, and partial output never succeeds.

Identity success requires whole-output raw-byte equality against the expected
top/Git/common paths and fixed booleans/object format. Failure classification
peels only the three path-free tail fields, preserving newline-bearing path
safety while distinguishing repository class, unsupported object format, and
malformed output.

Observations separate:

- versioned core identity and its length-prefixed SHA-256 fingerprint;
- device-only environmental evidence;
- self-describing local risk-scan scope and sorted signals.

Serialized values cross back into the type system only through
`parseRecordedObservation`. Unknown observation versions fail; differing
inspection-policy versions are not comparable.

## Consequences

- A1 introduces one process authority and exactly two repository spawns per
  successful inspection after lazy version validation.
- Production inspection creates no file, lock, log, temporary directory, or
  repository state.
- No config value or hook content is read. “No signals in scanned set” is not
  mutation authorization or a claim that the repository is safe.
- A caller-aborted request performs no request-path access or spawn.
- Node cannot preempt a kernel-blocked filesystem syscall. The total deadline
  is cooperative around filesystem calls and hard for child lifetime while the
  parent lives.
- Detached groups bound descendants while the daemon lives. A hard daemon kill
  leaves no upper orphan-lifetime guarantee. CT-04C mutation requires durable
  intent/reconciliation and a newly reviewed lifecycle.
- Strict symlink refusal is operationally restrictive but makes the first
  local trust boundary auditable.
- Postflight includes top-level directory size and mtime. Ordinary top-level
  entry creation, deletion, or rename can therefore return
  `observation-raced`. The operator accepts this conservative personal-use
  boundary; A2 must register only clean, quiescent working trees and retry
  after activity stops.
- Coherent source/reserved-root topology rejects overlap during inspector
  creation. A2 must not depend on receiving inspect-time
  `reserved-root-overlap`; reachable failures are `invalid-root-policy` or
  `outside-allowed-root`.
- The core fingerprint authenticates only its versioned core-identity fields.
  It does not authenticate risk-scan evidence, device evidence,
  `canonicalGitDirectory`, or `observedAt`. A2 must provide full serialized
  observation integrity for those fields, or a later reviewed policy version
  must widen the fingerprint.
- A2 may request and store a parsed observation but cannot construct Git argv,
  import the runner, or infer durable repository state from A1 alone.

## Alternatives considered

- **General Git wrapper or public command carrier** — rejected because it
  creates arbitrary process and next-slice mutation authority.
- **Clone and scrub `process.env`** — rejected because omissions are
  unreviewable; the child environment is constructed instead.
- **Whole-output mismatch as one malformed error** — rejected because it hides
  honest bare/subdirectory/redirection classifications.
- **Follow symlinks and trust `realpath` only** — rejected because replacement
  and operator-visible path identity become ambiguous.
- **Persist or compose the inspector in A1** — rejected as CT-04A2 authority.
