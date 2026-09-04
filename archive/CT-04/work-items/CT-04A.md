# CT-04A — Trusted Git boundary and repository registration

**Parent:** CT-04  
**Risk:** Critical  
**Dependencies:** accepted CT-03 baseline  
**Source baseline:** `abc5f37815ad76430cae989224afde817d77a047`  
**Primary areas:** Git process boundary, host-path policy, repository identity, repository registration, project binding, migration 0003, authorization

## Objective

Introduce the first real host-process boundary without creating a general shell. An authenticated Owner can register one existing operator-owned local Git repository under configured source roots. Owner or Editor can bind that repository to a same-workspace CraftingTable project. The daemon can then perform bounded read-only inspection and detect repository identity replacement.

CT-04A performs **no Git mutation** and creates no change request or worktree.

## Required outcomes

- replace the simulated production Git seam with a typed internal Git command runner;
- retain fake Git behavior only as test support, not normal composition;
- add configuration for allowed source roots and Git executable;
- reject unsafe/ambiguous root configuration at startup;
- add branded `RepositoryId` and `ProjectRepositoryBindingId`;
- add `RegisteredRepository`, `RepositoryPolicy`, and `ProjectRepositoryBinding` domain records;
- add strict HTTP contracts for repository registration, list/detail, retirement if included, and project binding;
- add migration 0003 with structural workspace/project ownership and immutable registration identity fields;
- require Owner for host-path registration;
- allow Owner/Editor to bind an already registered repository to a project;
- revalidate repository identity before every read-only inspection;
- add audit and workspace-event kinds through the CT-03 catalogs;
- call notifier after successful registration/binding transactions commit;
- document the trusted-repository assumption and known Git configuration limits.

## Binding decisions

### Path request

The registration request accepts one absolute source path plus a display name. It does not accept a worktree path, Git arguments, remote URL, or environment variables.

### Allowed roots

The daemon starts with one or more configured absolute source roots. Registration fails if the canonical repository top-level is not strictly below one root or overlaps the data, artifact, or managed-worktree roots.

### Repository class

CT-04 accepts an existing non-bare **primary worktree** only. It rejects:

```text
bare repositories
linked worktree directories
arbitrary subdirectories of a repository
non-Git directories
paths with rejected symlink behavior
repositories outside allowed roots
CraftingTable-managed worktree paths
```

### Physical uniqueness

One canonical repository identity may have one active CraftingTable registration globally in CT-04. Future explicit sharing must not be anticipated with weak duplicate rows.

### External-execution features

Inspection must identify known repository-local features that can cause Git to invoke external programs, including hooks/configured filters/fsmonitor/external diff/textconv where observable. The accepted plan must choose a clear policy: reject registration, mark a restrictive policy state that blocks later mutation, or require explicit Owner acknowledgment. It may not ignore the question.

## Required adversarial coverage

At minimum cover matrix groups:

```text
REG-PATH
REG-IDENTITY
REG-GIT-PROCESS
OWN-REPOSITORY
JOURNAL-REPOSITORY
```

## Non-goals

- no change request;
- no branch creation;
- no worktree creation/removal;
- no status/diff snapshot;
- no artifact store;
- no browser diff viewer;
- no arbitrary Git endpoint;
- no remote Git;
- no agent integration.

## Exit gate

```text
Owner registers a valid local repository under an allowed root.
Repository top-level, common directory, object format, and identity evidence persist.
The repository can be bound only to a project in the same workspace.
Editor cannot register a host path but can bind an admitted repository.
Viewer cannot mutate.
Outside-root, bare, linked-worktree, subdirectory, overlapping, and replacement cases fail safely.
No normal production route or service can execute arbitrary Git arguments.
All CT-01 through CT-03 tests still pass.
```
