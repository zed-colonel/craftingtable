# CraftingTable Implementation Plan

**Status:** development-planning baseline  
**Purpose:** build a small, local, Linux-hosted supervisory workbench that makes agent-assisted software development of the Exo Stack tractable  
**Primary host:** Keith's Linux workstation  
**Primary client:** any authenticated browser on the trusted local network, especially Keith's MacBook  
**First proving workload:** take `AQ-01` from approved work contract through implementation, verification, review, remediation, and human-approved merge  
**Product posture:** personal enabling tool, not a commercial product and not a fourth Exo Stack runtime dependency

---

## 0. Decision summary

CraftingTable will be a local web application and controller daemon for supervising coding agents, Git worktrees, deterministic verification, structured review, remediation, and merge readiness from one visual interface.

The central rule is:

> **CraftingTable exists to make the next Exo Stack work item easier. Features are justified by immediate development friction, not hypothetical product completeness.**

The first release will support one authenticated user, one primary coding backend (Codex), one active implementation loop at a time, and local human-approved merging. Its data model and authorization boundaries will be multi-user-safe from the beginning, but invitations, per-user execution isolation, and household collaboration will not block the first useful release.

CraftingTable will also preserve a clean seam for a future Planning Studio. Planning is not part of the initial AQ-01 milestone. The first release imports and operates on the structured plans already produced. After the workbench proves useful, a planning subsystem may produce the same artifact family:

```text
implementation plan
work-breakdown YAML
assumption ledger
validation manifest
decision record
```

The Planning Studio must produce proposals for human approval. It will not silently create executable work, branches, or agent runs.

### 0.1 Decisions fixed by this plan

1. The application is named **CraftingTable**.
2. It is a local web app backed by a persistent daemon on the Linux workstation.
3. The browser is a supervisory client, never the source of truth.
4. The daemon owns Git, worktrees, run state, verification, review state, and merge operations.
5. The first agent backend is Codex.
6. Claude Code and OpenCode are adapter targets after the first end-to-end loop works.
7. SQLite is the authoritative local workflow store.
8. Large logs, patches, transcripts, and verification artifacts live in a filesystem artifact store.
9. HTTP handles commands and queries; server-sent events provide reconnectable live updates.
10. The first user is created through a bootstrap command. Authentication is required before LAN exposure.
11. Every top-level domain record is scoped to a workspace even while only one user exists.
12. Git worktrees are bound to change requests and controlled by the daemon.
13. The coding agent does not own commits, merge authority, acceptance criteria, or protected verification.
14. A review applies only to an exact commit SHA.
15. A new commit invalidates prior readiness evidence unless a check explicitly declares itself content-independent.
16. The first successful milestone ends with a human-approved local merge of `AQ-01`.
17. CraftingTable does not depend on ActionQueue, WorldInterface, or Exoskeleton.
18. CraftingTable may later become a control plane for Exoskeleton, but that future does not shape MVP scope beyond clean interfaces and durable records.

### 0.2 What CraftingTable is not

CraftingTable is not initially:

- a new coding agent;
- a replacement IDE;
- a general workflow engine;
- a hosted SaaS product;
- a GitHub replacement;
- a team collaboration suite;
- an autonomous architecture authority;
- an implementation of the Exo Stack;
- a plugin marketplace;
- a distributed build farm;
- a remote shell exposed through a browser;
- a general secret-management system;
- a multi-tenant security boundary for mutually untrusted users.

The app may open a file or worktree in an external editor, but deep manual editing remains the editor's job.

---

## 1. Success criteria and governing scope

### 1.1 First useful release

CraftingTable is useful when Keith can perform this sequence from the MacBook without opening a terminal or cloning the repository there:

```text
log in to CraftingTable
    ↓
open the imported AQ-CONT-1 plan
    ↓
select AQ-01
    ↓
review and approve its work contract
    ↓
create branch and worktree on the Linux workstation
    ↓
start Codex
    ↓
observe normalized and raw activity
    ↓
inspect the resulting diff
    ↓
run deterministic verification
    ↓
start an independent read-only Codex review
    ↓
inspect and disposition structured findings
    ↓
return accepted findings to the implementation session
    ↓
verify and review the new commit
    ↓
see a merge-readiness decision
    ↓
approve the local merge
```

The browser may disconnect at any point. The daemon must continue safely and reconstruct the current state when the browser reconnects.

### 1.2 Explicit MVP omissions

The first useful release does not need:

- simultaneous agent runs;
- Claude Code integration;
- OpenCode integration;
- automatic merge;
- GitHub pull-request creation;
- user invitations;
- separate Unix accounts per user;
- direct API-driven plan generation;
- plan decomposition by an agent;
- embedded code editing;
- arbitrary terminal access;
- cloud synchronization;
- mobile-specific UI;
- organization features.

### 1.3 Scope admission rule

A proposed feature enters the MVP only if all three are true:

1. It is needed to complete or safely supervise the first AQ-01 loop.
2. It cannot be handled acceptably by a small manual step.
3. Its implementation does not create a new platform-sized subsystem.

Everything else is placed in the deferred roadmap.

### 1.4 Dogfood rule

After the first useful release, CraftingTable must immediately be used for real ActionQueue development. The app may receive improvements only when actual use reveals friction or a correctness problem.

> **Do not finish CraftingTable before using CraftingTable.**

---

## 2. Deployment and trust model

### 2.1 Physical topology

```text
Linux workstation
├── CraftingTable daemon
├── SQLite workflow database
├── artifact store
├── repositories and Git worktrees
├── Codex / Claude Code / OpenCode runtimes
├── compilers, test tools, and containers
└── reverse proxy / TLS endpoint
         │
         │ authenticated private-network access
         ▼
MacBook browser
```

The workstation is the trusted execution host. The MacBook is a supervisory client.

### 2.2 Process topology

```text
Browser
    │ HTTPS + JSON + SSE
    ▼
CraftingTable server
    ├── authentication and authorization
    ├── domain state machine
    ├── Git service
    ├── process supervisor
    ├── verification runner
    ├── review reducer
    ├── artifact service
    └── backend adapters
            ├── Codex app-server / CLI
            ├── Claude Agent SDK, later
            └── OpenCode server, later
```

The first implementation may run as one Node process with child processes for agents and checks. Internal module boundaries must make later process isolation possible without forcing it now.

### 2.3 Daemon ownership

The daemon owns:

- all authoritative workflow transitions;
- worktree creation and removal;
- branch naming and base pinning;
- generation commits;
- verification command execution;
- review generation identities;
- accepted and rejected finding state;
- merge-readiness evaluation;
- merge execution;
- event sequencing;
- artifact registration;
- user-visible audit history.

The browser submits typed commands. It never invokes Git or local processes directly.

### 2.4 LAN exposure

The application server should bind to loopback in the default deployment. A reverse proxy exposes it to the LAN over TLS.

Recommended shape:

```text
CraftingTable server
    127.0.0.1:4600

Caddy or equivalent reverse proxy
    https://craftingtable.<private-domain>
```

The reverse proxy and local DNS choice are operational details. The architectural requirement is authenticated TLS before normal MacBook use.

### 2.5 `systemd` operation

CraftingTable should install as a user service:

```ini
[Unit]
Description=CraftingTable local agent development workbench
After=network.target

[Service]
ExecStart=%h/.local/bin/craftingtable serve
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

The daemon must not require root. Optional user lingering may keep it running after logout.

---

## 3. Technology choices

### 3.1 Repository structure

Use a TypeScript monorepo:

```text
craftingtable/
├── apps/
│   ├── server/
│   └── web/
├── packages/
│   ├── contracts/
│   ├── domain/
│   ├── storage/
│   ├── git/
│   ├── agents/
│   ├── backend-codex/
│   ├── verification/
│   ├── planning/
│   └── testing/
├── docs/
├── scripts/
└── fixtures/
```

Physical packages may be consolidated initially if the dependency direction remains clear.

### 3.2 Server

Recommended baseline:

- Node.js with TypeScript;
- Fastify or an equivalently small typed HTTP framework;
- REST-style JSON commands and queries;
- server-sent events for live state and activity;
- Zod or equivalent shared schema validation;
- explicit service and repository layers;
- child-process supervision through typed wrappers.

SSE is preferred over WebSockets in the first release because live updates are server-to-client while commands remain ordinary authenticated POST requests. Event IDs allow native reconnection and replay.

### 3.3 Web client

Recommended baseline:

- React;
- Vite;
- a typed API client generated from shared contracts or written over shared schemas;
- a query cache for snapshots;
- SSE event application for live updates;
- responsive desktop-first layout;
- a dedicated diff component with inline annotation support;
- no embedded general-purpose IDE.

### 3.4 Storage

Use SQLite in WAL mode for authoritative workflow state.

Large or append-heavy material belongs in the artifact store:

```text
~/.local/share/craftingtable/
├── state/craftingtable.sqlite
├── repositories/
├── worktrees/
├── artifacts/
├── runs/
└── logs/
```

Artifacts should be content-addressed where practical. Database rows retain hashes, sizes, media types, and paths.

### 3.5 Git

Use the system Git CLI through a narrow typed service. Do not embed a second Git implementation initially.

Every invocation must:

- use an argument array rather than a shell string;
- run in a canonical registered repository or worktree;
- have a defined timeout;
- capture stdout, stderr, and exit status;
- emit a durable operation record;
- prohibit arbitrary browser-supplied flags.

### 3.6 Current backend feasibility assumptions

The first adapter will target Codex's documented app-server interface because it is intended to power rich clients. A non-interactive CLI fallback may be retained during the adapter spike.

Later adapters are feasible because Claude exposes the Claude Code agent loop through an Agent SDK and OpenCode exposes a programmatic server and generated SDK. These are integration assumptions, not reasons to delay the first Codex path.

Current source references checked during planning:

- Codex app-server: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Claude Agent SDK: <https://docs.anthropic.com/en/docs/claude-code/sdk>
- OpenCode server: <https://opencode.ai/docs/server/>
- GPT-5.6 in ChatGPT and the API: <https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt>
- GPT-5.6 Sol API model: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- OpenAI Structured Outputs: <https://developers.openai.com/api/docs/guides/structured-outputs>

No CraftingTable contract should expose a vendor's raw event types as its own durable domain model.

---

## 4. Core domain model

### 4.1 Identity and workspace records

```text
User
AuthIdentity
Session
Workspace
WorkspaceMembership
BackendProfile
```

Every project, repository, work item, run, artifact, and audit record belongs to a `WorkspaceId`.

### 4.2 Planning and project records

```text
Project
Repository
PlanBundle
PlanVersion
PlanArtifact
WorkItem
WorkItemDependency
WorkContract
Assumption
DecisionRecord
```

A `PlanBundle` groups the implementation plan, work-breakdown YAML, assumption ledger, and validation artifacts for one planning revision.

### 4.3 Execution records

```text
ChangeRequest
Worktree
AgentRun
AgentEvent
ApprovalRequest
Generation
CommitSnapshot
CheckRun
CheckResult
ReviewRun
ReviewFinding
FindingDisposition
ReadinessDecision
MergeOperation
Artifact
AuditEvent
```

### 4.4 Important distinctions

- A `WorkItem` is planned work.
- A `WorkContract` is the approved structural contract for one execution attempt.
- A `ChangeRequest` is the local PR analogue.
- An `AgentRun` is one backend session participating in a change request.
- A `Generation` is one immutable head commit plus its checks and reviews.
- A `ReviewRun` evaluates exactly one generation and head SHA.
- A `ReadinessDecision` is derived by policy; it is not an agent claim.
- A `MergeOperation` is performed only by the daemon after explicit authorization.

### 4.5 Work item lifecycle

```text
Proposed
    → Ready
    → Active
    → NeedsAttention
    → ReadyToMerge
    → Completed

Alternative terminal states:
    Blocked
    Canceled
    Superseded
```

### 4.6 Change request lifecycle

```text
Draft
    → Provisioning
    → Implementing
    → Verifying
    → Reviewing
    → Repairing
    → ReadyToMerge
    → Merging
    → Merged

Exceptional states:
    Blocked
    Escalated
    Failed
    Aborted
    MergeConflict
```

### 4.7 Agent run lifecycle

```text
Queued
    → Starting
    → Running
    → WaitingForApproval
    → CompletionProposed
    → Completed

Exceptional states:
    Blocked
    Interrupted
    Failed
    Canceled
```

### 4.8 Generation lifecycle

```text
Open
    → Committed
    → Verifying
    → Verified
    → Reviewing
    → Accepted

or

Open
    → Committed
    → VerificationFailed

or

Reviewing
    → BlockingFindings
    → SupersededByNextGeneration
```

A generation becomes immutable after the daemon creates its commit.

---

## 5. Authentication and multi-user seam

### 5.1 Initial authentication

The first release supports local credentials:

- username;
- password hashed with Argon2id or equivalent;
- server-side session records;
- secure, HTTP-only, same-site cookies;
- CSRF protection on mutating requests;
- session expiration and revocation;
- bootstrap through a CLI command, not a public registration endpoint.

Example:

```text
craftingtable admin bootstrap --username keith
```

The command may prompt for a password and create the first workspace.

### 5.2 Multi-user-safe data model

Even before a second user exists:

- no project is globally owned without a workspace;
- no backend profile is an unscoped singleton;
- no worktree is addressed only by filesystem path;
- no audit event omits the initiating user;
- no API assumes the current user is the sole administrator;
- no event stream is globally visible without workspace filtering;
- authorization checks occur in the service layer, not only in the UI.

### 5.3 Membership roles

Define but do not fully expose:

```text
Owner
Editor
Viewer
```

The first release uses only `Owner`. Later household use may activate invitations and additional roles.

### 5.4 Backend profile ownership

A backend profile records how an agent or model provider is invoked and who may use it.

```text
HostManaged
    uses credentials already available to the CraftingTable daemon's OS account

UserManaged
    uses encrypted credentials owned by one user

WorkspaceManaged
    uses credentials explicitly shared within a workspace
```

Only `HostManaged` needs implementation for the first Codex path. The ownership field must exist from the start.

### 5.5 Multi-user security boundary

Logical workspace isolation is not equivalent to safe execution isolation between mutually untrusted users.

Before enabling general multi-user execution, CraftingTable must add at least one of:

- separate Unix worker accounts;
- rootless containers with per-workspace mounts;
- another process boundary that prevents one agent from reading another workspace.

A future trusted-household mode can arrive earlier, but the UI and documentation must state its trust assumptions.

### 5.6 Audit attribution

Every state-changing command records:

```text
user
workspace
session
command type
object identifiers
prior state hash or version
resulting state hash or version
time
result
```

Agent actions and human actions remain distinguishable.

---

## 6. Plan and work-item ingestion

### 6.1 First supported input

CraftingTable will import the existing Exo Stack work-breakdown YAML format.

For example:

```yaml
document: AQ-CONT-1 Implementation Plan
repository: zed-colonel/actionqueue
baseline_commit: 97c9dc...
pull_requests:
  - id: AQ-01
    title: Freeze evidence and establish the development contract
    depends_on: []
    risk: medium
    exit_gate: Baseline green; contract, archive, and boundary checks installed.
```

The importer creates:

- a `Project`;
- a `PlanBundle` and `PlanVersion`;
- one `WorkItem` per PR entry;
- dependency edges;
- source artifact references;
- import diagnostics.

### 6.2 Import rules

- Imports are versioned, never silently overwritten.
- IDs must be unique within the project.
- Dependency graphs must be acyclic.
- Missing dependencies are errors unless explicitly external.
- Repository and baseline references are preserved.
- Unknown fields are retained in source artifacts even if not yet interpreted.
- Work items remain `Proposed` until the user admits them.

### 6.3 Work contract creation

A work item becomes executable only after a `WorkContract` is created and approved.

The contract includes:

```text
base branch and exact SHA
objective artifact
writable, read-only, and forbidden paths
required checks
acceptance criteria
risk class
review requirements
maximum generations
network and execution profile
merge policy
```

The first version may use an editor form and YAML preview rather than an agent to create the contract.

### 6.4 Cross-repository plans

The domain model supports dependencies across projects and repositories, but the first UI needs only one imported AQ plan. Cross-stack graph visualization is deferred until real parallel development begins.

---

## 7. Git and worktree subsystem

### 7.1 Repository registration

A registered repository contains:

```text
workspace
name
canonical path
remote metadata
integration branch
allowed worktree root
repository policy artifact
status
```

Registration verifies:

- the path exists and is a Git repository;
- the path is inside an allowed root;
- the configured integration branch exists;
- the repository is not currently in an unsafe operation;
- the daemon can create and remove worktrees.

### 7.2 Worktree binding

One worktree belongs to exactly one active change request.

```text
ChangeRequest AQ-01-1
    repository: actionqueue
    worktree: ~/.local/share/craftingtable/worktrees/actionqueue/AQ-01-1
    base: aq-cont-1@<sha>
    branch: ct/AQ-01
```

The agent may modify files inside that worktree. It may not change the bound branch, add sibling worktrees, or repurpose the directory.

### 7.3 Controller-owned generation commits

The implementation agent edits the worktree. The daemon:

1. checks path scope;
2. records the diff;
3. runs configured pre-commit checks;
4. stages allowed changes;
5. creates a generation commit;
6. records the exact head SHA;
7. begins verification and review against that SHA.

The agent does not create the authoritative generation commit in the first release.

### 7.4 Rebase and base changes

A change in base invalidates content-dependent evidence.

```text
integration branch changes
    ↓
change request marked BehindBase
    ↓
human chooses rebase or merge-base refresh
    ↓
daemon performs operation
    ↓
new head SHA
    ↓
required verification and review rerun
```

No background auto-rebase is required initially.

### 7.5 Merge policy

The first release supports human-authorized local squash merge or regular merge according to repository policy.

The daemon checks:

- exact head SHA matches the readiness decision;
- integration branch has not changed incompatibly;
- required checks and reviews remain current;
- no blocking findings remain;
- the worktree is clean;
- the user has merge permission.

### 7.6 Git safety invariants

- No arbitrary Git command endpoint exists.
- Destructive operations require explicit typed commands and confirmation.
- The daemon never force-pushes by default.
- The agent never receives merge authority.
- Every branch and worktree mutation is audited.
- Worktree cleanup refuses uncommitted or unregistered changes.

---

## 8. Agent backend architecture

### 8.1 Normalized adapter contract

```typescript
interface AgentBackend {
  describe(): Promise<BackendDescriptor>;

  start(input: StartRun): Promise<AgentRunHandle>;

  subscribe(
    runId: AgentRunId,
    onEvent: (event: AgentEvent) => void,
  ): Promise<Subscription>;

  sendDirective(
    runId: AgentRunId,
    directive: AgentDirective,
  ): Promise<void>;

  respondToApproval(
    runId: AgentRunId,
    response: ApprovalResponse,
  ): Promise<void>;

  inspect(runId: AgentRunId): Promise<AgentRunSnapshot>;

  cancel(
    runId: AgentRunId,
    reason: CancellationReason,
  ): Promise<void>;
}
```

### 8.2 Normalized events

```text
RunStarted
StatusChanged
PlanReported
ProgressReported
FileChanged
CommandStarted
CommandFinished
ApprovalRequested
UsageReported
ContextCompacted
CompletionProposed
Blocked
RunInterrupted
RunFailed
RunCanceled
RawBackendEventRecorded
```

These events describe observable behavior. CraftingTable does not attempt to extract or display hidden chain-of-thought.

### 8.3 Raw events

Every backend event is retained as an immutable raw artifact with:

```text
backend
backend version
run ID
sequence
received time
payload hash
payload artifact
```

Raw events help diagnose adapter behavior but do not directly drive user-visible workflow state without normalization.

### 8.4 Codex first

The Codex adapter spike should evaluate two paths:

1. app-server for rich, bidirectional sessions, approvals, and streamed updates;
2. `codex exec --json` as a simpler fallback.

The preferred target is app-server. The spike must prove:

- start a session in a selected worktree;
- receive streamed operational events;
- identify file and command activity;
- surface approvals;
- send a follow-up directive;
- stop or interrupt a run;
- resume a session after daemon restart or explicitly classify it as interrupted;
- separate implementation and read-only review profiles.

### 8.5 Backend capability descriptors

Each backend reports support for:

```text
streaming events
session resumption
approval requests
structured completion
read-only review mode
command events
file-change events
usage reporting
model selection
sandbox selection
```

The UI renders only supported controls.

### 8.6 Approval handling

The browser may approve a backend request only through a typed daemon command. Approval records include:

```text
requesting run
operation class
resource summary
backend payload reference
approving user
response
time
```

The first implementation profile should deny or require approval for network and out-of-scope access.

### 8.7 Claude Code and OpenCode later

After AQ-01 succeeds:

- add an OpenCode adapter over its server/SDK;
- add a Claude Code adapter over its Agent SDK;
- map capabilities honestly rather than forcing feature parity;
- use different backends for implementation and review when useful.

No second adapter should land merely to check a box. It must improve an upcoming real work item.

---

## 9. Verification subsystem

### 9.1 Verification is independent of agent claims

An agent's statement that tests passed is a claim. CraftingTable reruns configured checks and stores its own evidence.

### 9.2 Repository policy

Each registered repository may define:

```yaml
checks:
  fast:
    - id: fmt
      argv: [cargo, fmt, --all, --, --check]
    - id: check
      argv: [cargo, check, --workspace, --all-targets, --all-features]
  full:
    - id: clippy
      argv: [cargo, clippy, --workspace, --all-targets, --all-features, --, -D, warnings]
    - id: tests
      argv: [cargo, test, --workspace, --all-features]

protected_checks:
  - id: aq-contract
    runner: controller
```

The browser cannot submit arbitrary command strings. Commands are loaded from approved repository policy and work-contract records.

### 9.3 Check run record

```text
check ID
change request
generation
head SHA
command or protected runner ID
working directory
started and finished time
exit status
log artifact
summary
resource usage, when available
```

### 9.4 Protected acceptance checks

Acceptance checks may live outside the agent-writable worktree. They can be:

- controller-owned scripts;
- read-only fixtures;
- a separate checked-out conformance package;
- signed or hashed artifacts.

The agent may add developer tests. It may not rewrite protected acceptance criteria through the same patch it is trying to satisfy.

### 9.5 Scope verification

Before committing a generation, CraftingTable checks:

- every changed path against writable and forbidden scopes;
- symlink and canonical-path behavior;
- dependency additions;
- protected-file changes;
- maximum changed-file or diff-size policy;
- generated-file rules.

A scope violation blocks generation commit unless the human explicitly amends the work contract.

### 9.6 Check invalidation

A check is valid only for its recorded head SHA and relevant environment fingerprint.

A new commit invalidates all content-dependent checks.

---

## 10. Review, findings, remediation, and readiness

### 10.1 Review roles

The first release needs one independent read-only Codex review profile. The domain model supports multiple review profiles:

```text
Specification
Correctness
PersistenceRecovery
Security
Maintainability
```

### 10.2 Review input

A reviewer receives:

- the approved work contract;
- architecture and repository instructions;
- exact base and head SHAs;
- the diff;
- relevant surrounding code;
- deterministic check results;
- previous finding dispositions when reviewing a remediation generation.

It does not receive the implementation agent's full transcript by default.

### 10.3 Structured finding

```text
finding ID
review ID
head SHA
severity
category
path and line range
claim
evidence
suggested verification
confidence
status
```

### 10.4 Finding lifecycle

```text
Proposed
    → Accepted
    → Addressing
    → ClaimedAddressed
    → VerifiedResolved

or

Proposed
    → RejectedWithRationale

or

Proposed
    → Escalated
```

The model proposes findings. The human or configured deterministic policy decides whether they become blocking.

### 10.5 Remediation

Accepted findings are compiled into a narrow directive for the original implementation session:

```text
Address only these accepted findings.
Do not expand scope.
Do not modify protected acceptance tests.
Report any finding that cannot be resolved under the current contract.
```

The daemon then creates a new immutable generation commit and reruns required checks and reviews.

### 10.6 Loop bounds

The controller escalates when:

- maximum generations are reached;
- the same failure repeats without material progress;
- a fix reintroduces a resolved blocking issue;
- reviewers disagree on a blocking architectural point;
- scope expansion is required;
- the base changes materially;
- the agent stalls or becomes unresponsive;
- required evidence cannot be produced.

### 10.7 Readiness decision

A `ReadinessDecision` is a deterministic evaluation of:

```text
head SHA
scope status
required check status
required review status
blocking finding count
base compatibility
mergeability
risk policy
human-approval requirement
```

The first release never auto-merges. It may report `ReadyToMerge` and wait for Keith.

---

## 11. User interface

### 11.1 Home dashboard

The home screen answers:

```text
What work exists?
What is running?
What needs me?
What is ready?
```

Suggested sections:

```text
Needs attention
Active
Ready to merge
Blocked
Recently completed
```

### 11.2 Project and plan view

Show:

- plan versions;
- work-item list;
- dependency graph;
- risk and repository filters;
- upstream gates;
- readiness and blocking reasons;
- plan artifacts.

The first release may use a table and dependency summary rather than an elaborate graph canvas.

### 11.3 Work item view

Tabs:

```text
Overview
Contract
Change requests
Dependencies
Artifacts
History
```

### 11.4 Change request workspace

Primary tabs:

```text
Activity
Diff
Checks
Reviews
Findings
Git
Artifacts
```

The header always shows:

```text
repository
branch
base SHA
head SHA
current generation
agent backend
state
elapsed time
attention state
```

### 11.5 Activity view

Display normalized events prominently and raw backend events on demand.

Useful status examples:

```text
Planning
Editing 3 files
Running cargo test
Waiting for network approval
Completion proposed
Reviewing commit 91a7...
```

### 11.6 Diff and review view

Required features:

- changed-file tree;
- unified or side-by-side diff;
- syntax highlighting;
- inline findings and comments;
- generation selector;
- view of changes between remediation generations;
- stage/revert is not required in the first release unless real use proves necessary.

### 11.7 Checks view

Show deterministic evidence separately from model claims:

```text
format            passed
clippy            passed
workspace tests   failed
scope             passed
review             1 blocking finding
```

Each row links to logs and identifies the head SHA.

### 11.8 Remote behavior

- The UI can reload at any time.
- Snapshots come from ordinary API queries.
- SSE resumes after the last seen event ID.
- No correctness depends on an open browser connection.
- Long logs are paged or streamed from artifacts rather than loaded into one page.

---

## 12. Planning Studio seam

### 12.1 Why it belongs in the roadmap

The structured planning process is a major force multiplier and should eventually live beside execution. CraftingTable should be able to turn a project idea and selected evidence into a proposed planning bundle, then allow the user to edit, review, validate, and adopt it.

The goal is not to imitate ChatGPT's hidden implementation. The goal is to make the successful planning workflow explicit and reproducible:

```text
source acquisition
context mapping
architecture synthesis
implementation decomposition
independent critique
reconciliation
structured artifact generation
validation
human admission
```

### 12.2 Model availability reality

OpenAI currently documents GPT-5.6 Sol as an API model, while GPT-5.6 Sol Pro powers the Pro option in ChatGPT. CraftingTable should not claim that an API planning run exactly reproduces ChatGPT Pro. It can, however, reproduce much of the process quality through deliberate tooling, multi-stage review, structured outputs, source grounding, and deterministic artifact validation.

### 12.3 Planning provider abstraction

Planning is separate from coding-agent execution:

```typescript
interface PlanningProvider {
  describe(): Promise<PlanningProviderDescriptor>;
  start(input: PlanningRunInput): AsyncIterable<PlanningEvent>;
  continue(runId: PlanningRunId, directive: PlanningDirective): Promise<void>;
  cancel(runId: PlanningRunId): Promise<void>;
}
```

Possible providers:

```text
CodexPlanningBackend
    uses Codex with a read-only planning profile and existing subscription access

OpenAIResponsesPlanningBackend
    uses GPT-5.6 Sol with structured outputs and explicit tools

ClaudePlanningBackend
    uses Claude as planner or critic
```

### 12.4 Planning run stages

```text
Intake
    capture outcome, constraints, repositories, and source material

SourceInventory
    identify authoritative and missing inputs

ContextMap
    summarize architecture, state, decisions, and uncertainties

Draft
    produce the first coherent plan

Critique
    run scope, architecture, testing, security, and dependency critics

Reconciliation
    resolve findings and preserve contested decisions

ArtifactEmission
    produce Markdown and machine-readable artifacts

Validation
    check schemas, IDs, dependency cycles, references, and required sections

HumanReview
    edit and approve

Adoption
    create proposed WorkItems, never automatically executable ones
```

### 12.5 Planning artifacts

The initial target family is:

```text
ImplementationPlan.md
WorkBreakdown.yaml
AssumptionLedger.yaml
ValidationManifest.json
DecisionLog.md
```

The same import path used by current Exo Stack plans should consume planner output.

### 12.6 Planning evidence and reproducibility

A planning run stores:

```text
selected source artifacts and hashes
provider and model
prompt/instruction version
stage outputs
critic findings
human edits
validation results
final artifact hashes
```

CraftingTable stores useful rationales and critiques, not hidden chain-of-thought.

### 12.7 Planning is gated after dogfood

The Planning Studio should not begin until:

1. AQ-01 completes through CraftingTable.
2. The imported-plan workflow proves the domain model.
3. Real use identifies which planning views and artifacts are most valuable.

The architecture seam exists now so the planning feature does not require rewriting core records later.

---

## 13. Persistence, recovery, and artifacts

### 13.1 Database responsibilities

SQLite stores:

- users, sessions, workspaces, and memberships;
- projects, repositories, plans, and work items;
- change requests and worktrees;
- agent-run state and normalized events;
- generations and commit identities;
- checks, reviews, findings, and readiness;
- audit events;
- artifact metadata.

### 13.2 Filesystem artifact responsibilities

The artifact store retains:

- raw agent event streams;
- prompts and structured outputs;
- command logs;
- patches and diff snapshots;
- verification logs;
- review results;
- imported and generated plan files;
- backup manifests.

### 13.3 Event sequencing

All durable domain events receive a monotonic sequence number within the server instance.

SSE clients reconnect with `Last-Event-ID`. The server sends missed events or instructs the client to refresh its snapshot if retention has expired.

### 13.4 Daemon restart behavior

On restart:

1. mark unconfirmed in-memory operations as interrupted;
2. inspect registered worktrees and Git state;
3. reconcile child-process records;
4. reconnect to or restart backend services where supported;
5. classify agent runs as resumed, interrupted, or failed;
6. preserve all completed generations and evidence;
7. avoid automatically rerunning commands with side effects;
8. surface required operator attention.

### 13.5 Backup

A backup contains:

```text
consistent SQLite backup
artifact manifest and selected artifacts
configuration without raw secrets
repository registration metadata
```

Repositories and worktrees are not necessarily copied because Git can reconstruct them, but unpushed generation commits must be protected. The backup command should warn when local-only commits exist.

### 13.6 Retention

Initial policy:

- keep all domain records;
- keep final artifacts and all generation diffs;
- keep raw agent events and command logs until manually pruned;
- expose storage usage before implementing automatic deletion.

---

## 14. Security model

### 14.1 Control plane versus execution plane

```text
Trusted control plane
    authentication
    workflow state
    Git authority
    verification policy
    merge authority

Constrained execution plane
    coding agent
    worktree access
    configured commands
    no merge authority
```

The first implementation may run both under one Unix user, but the API and code boundaries must reflect the distinction.

### 14.2 Browser restrictions

The browser cannot submit:

- arbitrary shell commands;
- arbitrary filesystem paths;
- raw Git argument arrays;
- backend credentials;
- unrestricted environment variables;
- an instruction to bypass checks;
- an agent-defined merge decision.

### 14.3 Path safety

All repository, worktree, artifact, and file references are canonicalized and checked against registered roots. Symlink traversal outside the allowed root is rejected.

### 14.4 Secret handling

- Agent credentials never enter the browser.
- Password hashes and encrypted provider material remain server-side.
- Logs redact configured secret patterns.
- Work contracts declare whether network or credentials are permitted.
- The first Codex profile should use the existing local Codex authentication without copying credential files into worktrees.

### 14.5 Command safety

Verification commands are selected by ID from repository policy. The UI may select a check but cannot alter its command line.

### 14.6 Human commands as authority

Privileged actions require explicit typed UI operations:

```text
ApproveWorkContract
ApproveAgentOperation
AcceptFinding
RejectFinding
AmendScope
AuthorizeMerge
AbortRun
```

Natural-language content from an agent, file, issue, or review is never parsed as control authority.

---

## 15. Implementation lanes

### 15.1 Critical path

```text
foundation
    ↓
authenticated persistent daemon
    ↓
plan/work-item import
    ↓
Git and worktrees
    ↓
Codex run supervision
    ↓
verification and generations
    ↓
review and remediation
    ↓
readiness and merge
    ↓
AQ-01 dogfood
```

### 15.2 Parallel work allowed after the foundation

Once shared contracts and storage are stable:

- basic web layout may proceed beside Git service work;
- fake-backend UI work may proceed before Codex integration;
- repository-policy parsing may proceed beside worktree management;
- plan-import validation may proceed beside auth hardening.

### 15.3 Post-MVP lanes

Only after AQ-01:

```text
parallel run scheduler
Claude Code adapter
OpenCode adapter
Planning Studio
trusted-household multi-user activation
optional GitHub publication
```

---

## 16. Pull-request implementation sequence

### CT-01 — Establish scope, repository contract, and executable skeleton

**Risk:** medium  
**Dependencies:** none

#### Work

- Create the `craftingtable` repository and TypeScript workspace.
- Add the scope charter from this plan.
- Add `AGENTS.md`, architecture boundaries, and contribution rules.
- Establish server, web, shared-contract, and test packages.
- Add formatting, linting, type checking, unit tests, and a minimal end-to-end smoke test.
- Define the normalized domain IDs and event envelope.
- Create a fake agent backend and fake Git service for UI development.
- Add the ADR queue.
- Add forbidden-scope checks preventing dependencies on the Exo Stack repositories.

#### Exit gate

```text
server starts
web app loads
shared schemas compile
fake event appears in the UI
quality gates pass
scope charter is installed
```

### CT-02 — Build the persistent daemon, authentication, workspaces, and audit journal

**Risk:** high  
**Dependencies:** CT-01

#### Work

- Add SQLite schema and migrations.
- Implement `User`, `Session`, `Workspace`, and `WorkspaceMembership`.
- Add bootstrap-admin CLI.
- Implement password login, logout, session revocation, and CSRF protection.
- Add workspace-scoped service authorization.
- Add append-only audit records and monotonic domain-event sequencing.
- Add snapshot queries and SSE replay.
- Add daemon-restart tests.

#### Exit gate

```text
bootstrap user can log in
all data is workspace-scoped
audit records identify the user
browser reconnect reconstructs state
restart preserves durable state
```

### CT-03 — Import plan bundles and render the project/work-item dashboard

**Risk:** medium  
**Dependencies:** CT-02

#### Work

- Implement `Project`, `PlanBundle`, `PlanVersion`, `WorkItem`, and dependencies.
- Import AQ-CONT-1 implementation-plan and work-breakdown artifacts.
- Validate IDs and dependency cycles.
- Preserve source artifacts and import diagnostics.
- Add project, plan, and work-item pages.
- Add readiness, risk, dependency, and blocker summaries.
- Add manual work-item admission and work-contract draft creation.

#### Exit gate

```text
AQ plan imports without lost fields
AQ-01 through AQ-14 appear with dependencies
AQ-01 can be admitted and given a draft contract
invalid plans fail with actionable diagnostics
```

### CT-04 — Implement repository registration, worktrees, change requests, and diff snapshots

**Risk:** high  
**Dependencies:** CT-02, CT-03

#### Work

- Add registered repositories and repository policy.
- Implement canonical-path validation.
- Add change requests and bound worktrees.
- Create task branches from exact base SHAs.
- Capture status and diff snapshots.
- Add generation placeholders and Git-operation audit records.
- Add diff API and initial diff viewer.
- Add cleanup safeguards.

#### Exit gate

```text
AQ-01 creates a controlled actionqueue worktree
base and branch identities are visible
diff appears in the browser
unsafe paths and dirty cleanup are rejected
```

### CT-05 — Integrate Codex and stream supervised agent activity

**Risk:** high  
**Dependencies:** CT-04

#### Work

- Complete the Codex app-server versus CLI spike.
- Implement the normalized Codex adapter.
- Start an implementation run in the bound worktree.
- Persist normalized and raw events.
- Show live status, commands, file changes, progress, and usage where available.
- Surface approval requests and typed responses.
- Implement cancel and interruption handling.
- Add a read-only Codex profile for later review.

#### Exit gate

```text
Codex starts from the AQ-01 page
browser shows live observable activity
approval requests are visible and auditable
closing the browser does not stop the run
run interruption is recovered or honestly classified
```

### CT-06 — Add verification, scope enforcement, and controller-owned generations

**Risk:** high  
**Dependencies:** CT-04, CT-05

#### Work

- Implement repository check-policy parsing.
- Add scope verification against the work contract.
- Run fast and full checks through typed commands.
- Store logs and check manifests.
- Create controller-owned generation commits.
- Tie checks to exact head SHAs.
- Add protected-check runner seam.
- Invalidate stale evidence after a new generation.

#### Exit gate

```text
agent completion becomes only a proposal
scope violations block commit
controller creates generation commit
checks run against exact SHA
logs and evidence are visible
```

### CT-07 — Implement structured review, finding disposition, and remediation

**Risk:** high  
**Dependencies:** CT-06

#### Work

- Add read-only independent Codex review runs.
- Define structured review-output schema.
- Render inline findings in the diff.
- Add accept, reject-with-rationale, and escalate actions.
- Compile accepted findings into a remediation directive.
- Resume the original implementation session.
- Create the next generation and rerun checks/review.
- Enforce maximum generation count and stagnation escalation.

#### Exit gate

```text
review applies to one exact SHA
findings are structured and visible inline
accepted findings return to implementer
new generation invalidates stale review
loop terminates or escalates deterministically
```

### CT-08 — Implement readiness, human merge, recovery, and LAN deployment

**Risk:** critical  
**Dependencies:** CT-07

#### Work

- Add deterministic merge-readiness evaluator.
- Add merge authorization UI.
- Implement configured local merge strategy.
- Detect base divergence and merge conflicts.
- Add end-to-end restart recovery for active change requests.
- Add backup and restore commands.
- Add `systemd` user-service packaging.
- Document reverse-proxy TLS deployment.
- Run security review for auth, CSRF, path handling, and command boundaries.

#### Exit gate

```text
only current evidence can produce ReadyToMerge
Keith must explicitly authorize merge
merge is audited and reproducible
restart and browser disconnect do not lose state
CraftingTable is safely reachable from the MacBook
```

### CT-09 — Dogfood AQ-01 and harden only from observed friction

**Risk:** high  
**Dependencies:** CT-08

#### Work

- Execute AQ-01 through the complete CraftingTable loop.
- Record every manual workaround and point of confusion.
- Fix only issues that materially block or weaken the real loop.
- Add regression tests for discovered failures.
- Publish a short dogfood report.
- Remove fake or unused MVP paths.
- Freeze the first useful release.

#### Exit gate

```text
AQ-01 merges through CraftingTable
no MacBook repository clone is required
no terminal is required for the normal supervisory path
all interventions are represented in durable state
first useful release is declared
```

### CT-10 — Add bounded parallelism and resource scheduling

**Risk:** high  
**Dependencies:** CT-09

#### Work

- Permit multiple active change requests in separate worktrees.
- Add host CPU, memory, and build-concurrency limits.
- Detect overlapping writable scopes.
- Add project-level active-run dashboard.
- Add dependency-aware start restrictions.
- Add per-backend concurrency limits.

#### Exit gate

```text
two nonconflicting work items can run safely
resource pressure is bounded
overlapping scope is blocked or explicitly approved
parallel status is understandable from one screen
```

### CT-11 — Add OpenCode and Claude Code adapters

**Risk:** medium  
**Dependencies:** CT-09; CT-10 recommended

#### Work

- Implement OpenCode server adapter.
- Implement Claude Agent SDK adapter.
- Add backend capability matrix.
- Add implementation and review profiles.
- Validate session, approval, cancellation, and event differences.
- Add backend-selection policy per work contract.

#### Exit gate

```text
each adapter passes the shared backend conformance suite
UI does not assume Codex-only features
a real work item demonstrates useful backend choice
```

### CT-12 — Add Planning Studio artifact workflow

**Risk:** medium  
**Dependencies:** CT-09

#### Work

- Add planning projects, runs, stages, and artifact versions.
- Add source selection and artifact upload.
- Add Markdown and structured-artifact editor views.
- Add schema and dependency validation.
- Add manual critic findings and reconciliation records.
- Allow approved plan bundles to create proposed work items.

#### Exit gate

```text
a plan can be assembled, reviewed, validated, versioned, and adopted
no model generation is required yet
adoption never makes work executable without contract approval
```

### CT-13 — Add model-assisted planning pipeline

**Risk:** high  
**Dependencies:** CT-12

#### Work

- Implement `PlanningProvider`.
- Add a Codex planning profile or direct OpenAI Responses provider.
- Add structured stage outputs.
- Add architecture, scope, testing, security, and dependency critics.
- Add reconciliation and final artifact emission.
- Record model, source, prompt, and artifact provenance.
- Add budget and cancellation controls.
- Validate the process on one small non-Exo hobby project before relying on it for stack architecture.

#### Exit gate

```text
planning run produces a valid reviewable plan bundle
human edits and decisions remain authoritative
provenance and critic history are inspectable
no plan silently launches implementation
```

### CT-14 — Activate trusted-household multi-user support

**Risk:** high  
**Dependencies:** CT-09; execution-isolation decision required

#### Work

- Add invitations and membership management.
- Add separate user workspaces.
- Add per-user or explicitly shared backend profiles.
- Add workspace-filtered events and artifacts.
- Add execution isolation appropriate to the declared trust model.
- Add quota and concurrency ownership.
- Add household-use documentation.

#### Exit gate

```text
a second user can log in to an isolated workspace
backend and repository access are explicit
one user's UI cannot view another workspace
declared execution-isolation guarantees are tested
```

---

## 17. Test strategy

### 17.1 Domain tests

- lifecycle transition properties;
- exact-SHA evidence invalidation;
- finding lifecycle;
- readiness evaluation;
- workspace authorization;
- dependency-cycle rejection;
- event sequencing.

### 17.2 Git fixture tests

Create disposable repositories to test:

- repository registration;
- worktree creation and cleanup;
- branch binding;
- dirty-state rejection;
- generation commits;
- base divergence;
- merge conflicts;
- scope and symlink traversal;
- local-only commit backup warnings.

### 17.3 Fake backend conformance

The fake backend must simulate:

- normal completion;
- streamed events;
- approval requests;
- failure;
- cancellation;
- interruption;
- malformed raw events;
- duplicate events;
- delayed completion;
- remediation.

Every real backend passes the same normalized contract tests.

### 17.4 Server integration tests

- login and session revocation;
- workspace authorization;
- CSRF rejection;
- SSE replay;
- restart recovery;
- artifact retrieval;
- command idempotency;
- concurrent command rejection.

### 17.5 Browser tests

Use browser automation for:

- login;
- plan import;
- AQ-01 admission;
- worktree creation;
- fake-agent run;
- diff display;
- check results;
- finding disposition;
- merge approval.

### 17.6 Dogfood acceptance

The real AQ-01 path is the release acceptance test. Automated tests support it but do not replace it.

---

## 18. Observability and research data

### 18.1 Operator questions

CraftingTable should answer:

```text
What is each agent doing?
What changed?
Which SHA was reviewed?
Which checks are current?
What needs human attention?
Why is work blocked?
What evidence supports readiness?
How much time and inference did the work consume?
```

### 18.2 Delegation research records

Preserve:

- work-contract versions;
- backend and model;
- raw and normalized events;
- approvals;
- commands and results;
- diffs and generation SHAs;
- checks;
- findings and dispositions;
- remediation instructions;
- human interventions;
- merge decision;
- elapsed time and usage.

### 18.3 Useful future analyses

- percentage of change requests reaching readiness without intervention;
- average remediation generations;
- scope-expansion frequency;
- review finding confirmation rate;
- false-completion claims;
- backend strengths by task class;
- stagnation indicators;
- human intervention causes;
- post-merge defect rate;
- parallel-work conflict rate.

This evidence can directly inform Exoskeleton's future Delegation and Verification Plane.

---

## 19. Risk register

### R1 — Building the tool instead of the stack

**Mitigation:** CT-09 is mandatory. No post-MVP feature begins until AQ-01 merges through CraftingTable.

### R2 — UI scope expands into an IDE

**Mitigation:** provide diff, findings, logs, and “open in editor”; omit full editing, language services, and terminal multiplexing.

### R3 — Vendor event protocols churn

**Mitigation:** narrow adapters, raw-event retention, capability descriptors, and fake-backend conformance.

### R4 — Agent gains too much host authority

**Mitigation:** worktree scoping, harness sandbox, typed approvals, no merge credential, no arbitrary browser shell.

### R5 — Multi-user fields create false security confidence

**Mitigation:** document logical versus execution isolation; do not enable untrusted users before process isolation.

### R6 — Review loop becomes endless

**Mitigation:** generation limits, progress checks, repeated-failure detection, explicit escalation.

### R7 — Stale evidence authorizes new code

**Mitigation:** all checks, reviews, and readiness records bind to exact SHAs.

### R8 — Planning Studio becomes a second large project

**Mitigation:** planning begins only after dogfood and first supports artifact workflow before model orchestration.

### R9 — Local-only commits or artifacts are lost

**Mitigation:** backup warnings, artifact manifests, durable generation identities, and optional push after merge.

### R10 — API or subscription assumptions are wrong

**Mitigation:** backend profiles declare authentication and billing mode; adapter spikes verify real entitlements before architecture depends on them.

---

## 20. Definition of first useful release

CraftingTable reaches its first useful release when all of the following are true:

### Access and durability

- Keith can authenticate from the MacBook over TLS.
- The daemon runs as a user service on the Linux workstation.
- Browser disconnection does not stop work.
- Restart reconstructs or honestly interrupts active state.

### Planning and work

- AQ-CONT-1 planning artifacts are imported.
- AQ-01 is visible with dependencies, risk, and exit gate.
- An approved structural work contract exists.

### Git

- The daemon creates and owns the AQ-01 worktree and branch.
- Base and head SHAs are always visible.
- The daemon creates generation commits.
- Diff review works from the browser.

### Agent supervision

- Codex starts, streams activity, requests approval, and can be stopped.
- Raw and normalized events are retained.
- The implementation session can receive accepted findings.

### Verification and review

- Scope enforcement runs independently.
- Required repository checks run and retain logs.
- A fresh read-only review produces structured findings.
- Finding disposition and remediation work.
- Evidence becomes stale after a new commit.

### Merge

- Readiness is policy-derived for an exact SHA.
- Keith explicitly authorizes merge.
- AQ-01 merges locally through CraftingTable.
- The complete history remains inspectable.

### Scope

- No Claude or OpenCode adapter is required.
- No plan-generation model is required.
- No second user is required.
- No GitHub Action or GitHub PR is required.

---

## 21. Immediate issue set for CT-01

1. Create `zed-colonel/craftingtable` or the chosen local repository.
2. Add this plan and the work-breakdown YAML.
3. Add `README.md` with the scope charter.
4. Add `AGENTS.md` with architectural and quality boundaries.
5. Initialize the TypeScript workspace.
6. Create `apps/server` and `apps/web`.
7. Create shared contracts and domain packages.
8. Add a fake backend and fake event stream.
9. Add a minimal dashboard shell.
10. Add lint, format, type-check, unit-test, and browser-smoke commands.
11. Add CI-equivalent local scripts, even if GitHub Actions are not used.
12. Create the ADR queue:
    - ADR-001 server and web framework;
    - ADR-002 SQLite library and migration tool;
    - ADR-003 SSE event contract;
    - ADR-004 diff viewer choice;
    - ADR-005 Codex integration path;
    - ADR-006 local TLS deployment;
    - ADR-007 agent execution boundary.
13. Add forbidden dependency checks against ActionQueue, WorldInterface, and Exoskeleton runtime crates.
14. Open CT-02 implementation issues.

---

## Appendix A — Dependency overview

```text
CT-01
  ↓
CT-02
  ├──→ CT-03
  └──→ CT-04 ← CT-03
           ↓
         CT-05
           ↓
         CT-06
           ↓
         CT-07
           ↓
         CT-08
           ↓
         CT-09
          ├──→ CT-10
          ├──→ CT-11
          ├──→ CT-12 → CT-13
          └──→ CT-14
```

## Appendix B — Suggested repository policy for the ActionQueue pilot

```yaml
repository: actionqueue
integration_branch: aq-cont-1
merge_strategy: squash

agent:
  default_backend: codex
  network: deny
  max_generations: 3

checks:
  fast:
    - id: fmt
      argv: [cargo, fmt, --all, --, --check]
    - id: check
      argv: [cargo, check, --workspace, --all-targets, --all-features]
  full:
    - id: clippy
      argv:
        [cargo, clippy, --workspace, --all-targets, --all-features, --, -D, warnings]
    - id: test
      argv: [cargo, test, --workspace, --all-features]

merge:
  human_authorization_required: true
  require_current_full_checks: true
  require_no_blocking_findings: true
```

## Appendix C — Planning-bundle contract

```text
PlanBundle
├── metadata
├── ImplementationPlan.md
├── WorkBreakdown.yaml
├── AssumptionLedger.yaml, optional
├── ValidationManifest.json, optional
└── DecisionLog.md, optional
```

A bundle is versioned and content-addressed. Adoption creates proposed project records; it does not launch work.

## Appendix D — Deferred future integrations

Potential later uses include:

- GitHub push and PR publication;
- a visual ActionQueue inspector;
- WorldInterface receipt and effect views;
- Exoskeleton delegated-work supervision;
- Agent Host control;
- organization-level workspaces;
- remote worker machines.

These remain future possibilities. They do not belong to the initial implementation contract.
