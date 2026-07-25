# CT-04D — Immutable status/diff evidence and bounded artifact storage

**Parent:** CT-04  
**Risk:** High  
**Dependencies:** accepted CT-04C  
**Primary areas:** status parser, patch capture, untracked evidence, artifact store, immutable diff snapshots, migration 0006

## Objective

Capture a bounded, immutable observation of one exact managed worktree state. CraftingTable must distinguish staged, unstaged, untracked, conflicted, binary, symlink, submodule, special-file, unsupported-encoding, and truncated conditions without invoking repository-configured renderers or presenting partial output as complete.

## Required outcomes

- add `ArtifactId` and `DiffSnapshotId`;
- introduce a narrow content-addressed filesystem artifact package;
- add migration 0006 for artifact metadata and immutable diff snapshots;
- publish artifact bytes durably before committing metadata references;
- extend the accepted CT-04C NUL-safe status parser into a complete typed status manifest;
- validate path encoding before JSON serialization;
- capture staged and unstaged tracked patches separately;
- disable external diff, textconv, pagers, and fsmonitor behavior as applicable;
- collect bounded untracked regular-file evidence without following symlinks;
- classify binary, symlink, submodule, special, unsupported, and oversized entries;
- preserve truncation/incompleteness as first-class state;
- tie every snapshot to exact repository identity, base SHA, observed HEAD, worktree, change request, and generation placeholder;
- make snapshots immutable; refresh creates a new snapshot;
- add authorized list/detail/artifact endpoints by opaque IDs;
- add post-commit audit/event notification for capture completion or structured failure.

## Artifact boundary

Artifact fetch never accepts a host path or content hash as authority. It resolves an opaque artifact ID through authorized parent ownership, then derives a filesystem path from trusted stored metadata.

CT-04 adds no artifact deletion or garbage collection. Orphans caused by a crash before metadata commit are tolerated and must not be reachable from the API.

## Required adversarial coverage

```text
DIFF-STATUS-PARSE
DIFF-TRACKED
DIFF-UNTRACKED
DIFF-BINARY
DIFF-SYMLINK
DIFF-SUBMODULE
DIFF-LIMITS
DIFF-EXTERNAL-EXECUTION
ARTIFACT-ATOMICITY
ARTIFACT-INTEGRITY
OWN-DIFF
JOURNAL-DIFF
```

## Non-goals

- no syntax-aware editor;
- no hunk staging/reverting;
- no file mutation through the browser;
- no verification checks;
- no generation commit;
- no review findings;
- no merge readiness.

## Exit gate

```text
A manually changed managed worktree produces one immutable snapshot.
Staged, unstaged, and untracked evidence are distinguishable.
Malicious filenames do not break parsing or HTML rendering.
External diff/textconv/pager hooks are not invoked.
Oversized or unsupported content is classified, not silently omitted.
Artifact metadata never points to missing bytes under injected crash tests.
Prior snapshots remain byte-identical after refresh.
```
