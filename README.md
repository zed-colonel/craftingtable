# CraftingTable

CraftingTable is a local supervisory workbench for planning, delegating, observing,
reviewing, and integrating software work performed by existing coding agents.

It runs as a daemon on your workstation. From a browser on any machine on your home
network you import a plan, admit a work item into your agenda, register a repository,
create a worktree, launch Claude Code or Codex with the work item as its brief, watch it work
live, steer it, have a second run review the branch, and merge it when the review says
it is mergeable.

## What works today

- **Shared decision review.** Roadmaps and work-item design recovery show pending architecture
  questions and applicable approvals together. New designs supply a standalone recommendation,
  rationale, alternatives, consequences and source citations. Review the recommendation or edit
  it, save the exact proposal, then explicitly approve it as repository maintainer. References
  and source-report identities are collected automatically. Limited approval names its slices
  and retained obligations; implementation, test and parent gates remain separate. Older reports
  without complete briefs offer clarification or a manual decision. Design recovery shows approval
  times and coverage after **Refresh available evidence**; approval never resumes a run.
- **Plans and work items.** Import an implementation plan plus work breakdown as a plan
  bundle; browse projects, plan versions, and work items with their dependencies. Items
  move `Proposed → In agenda → Completed`; completing one unblocks its dependents.
  **Import plan → Import ZIP archive** previews a full package and adds a preserved version
  to an existing project. Use **Remove from agenda** on an unstarted work item to return it
  to Proposed without recording a completion. Choose **Make active** to use it when prior work is idle, then
  configure that new version's repository/branches. Original ZIPs remain downloadable.
- **Repository policy and transition evidence.** Under **Repository & branches → Record repository
  policy**, adopt the local integration interpretation, an optional frozen experimental branch
  at its observed commit, and the separately due remote-publication obligation. Adoption creates
  an immutable operator record; it does not configure hosting protections, move Git refs, or start
  agents. Every run receives fresh local observations and the policy, with explicit limits on what
  is verified. Prior operator guidance accompanies related slices, independent verification,
  parent acceptance, and finalization. Policy changes require fresh review/acceptance evidence;
  frozen-branch drift blocks fresh review until resolved. Ordinary controller merges cannot target
  a frozen branch; final promotion still needs explicit operator approval. These typed records and
  commands are also the integration point for future planning interfaces.
- **Cross-project map previews.** **Roadmaps → Import concurrency map** accepts v0.3 ZIPs,
  checks source documents and phase dependencies, and saves an inactive draft. Choose exact
  WI/EXO plan versions and the registered upstream repository, then **Save exact bindings**.
  Saved selections are shown separately from future baseline verification and execution setup.
  The preview shows missing configuration, targets, proposed decisions, resources and gates;
  adoption and Start are explicit actions in the target supervisor.
- **Execution slices and parent acceptance.** Bound map slices appear on their work-item
  pages and in the roadmap editor's **Execution scope** selector. Each slice has its own
  branch, worktree and cycle. A slice merge leaves its parent incomplete. Record slice
  verification from a successful scoped review; if integration has advanced, create a fresh
  verification review. Once all required slices and evidence are verified, create a parent
  acceptance worktree, launch its review, and use **Accept parent after review**. Only that
  acceptance completes the parent and releases its dependents. Reviews retain evidence in a
  separate run artifact. Active verification and parent-acceptance cycles appear in the work item's
  **Automated cycle** selector, with guidance/resume recovery and current phase requirements.
  **Review again with existing verification cycle** reuses a completed review’s worktree and assigned
  reviewer. Add guidance, then **Start fresh scope review** explicitly; the daemon requires an idle,
  clean snapshot and fast-forwards it from integration. Older runs and receipts remain in history.
  Recovery retains prior instructions and starts another review; source changes belong to the
  owning slice. Stale verification must be refreshed before parent acceptance can resume.
  The reference WI/EXO map retains its adoption, environment and evidence gates; importing or selecting a slice never approves
  those requirements. Existing whole-item workflows remain available.
- **Transition scheduling and resources.** Execution scopes show separate start, integration,
  verification and parent-acceptance requirements, with typed waiting reasons and reservations.
  Requirements inherit earlier phases; resource reservations apply only to the current phase.
  Resource waits retry automatically. Finished runs release their slots; merged slices and
  review-only worktrees release development capacity. Source-declared early development needs
  explicit authorization for the exact bound slice and does not relax parent acceptance.
  Native/Kata qualification, current upstream pins and unresolved map decisions remain visible gates.
  Local scoped development defaults to 2 admission slots; verification/acceptance defaults to 1.
  **Settings → Execution capacity** groups development/work-item review and independent
  verification/parent-acceptance pools with each saved roadmap’s total and per-repository in-flight
  limits. Roadmaps show usage and link to the selected settings. Save a new roadmap draft before
  configuring its capacity. Workstation pools (1–32) require an owner of every active workspace;
  roadmap ceilings (1–16) retain workspace owner/editor authority. Pause affected scheduling before
  saving. Both workstation overrides survive restart and take precedence over
  `CRAFTINGTABLE_DEVELOPMENT_CAPACITY` and `CRAFTINGTABLE_VERIFICATION_CAPACITY`; otherwise those
  environment values supply defaults. Occupied runs, recorded waits and in-flight work link to
  their details. Explicit refresh preserves unsaved drafts and rejects stale saves. Lower limits
  retain active work and delay new admissions. Roadmap capacity saves create a new definition
  without changing started attempts, profiles, recovery budgets or scope.
  These coordinate daemon work, not host CPU or isolation.
  Saved cross-project roadmaps show occupied/total workstation slots beside their in-flight limits.
  Workstation slots are shared across projects; setting four roadmap items and two per repository
  does not override a two-slot workstation limit. Changing workstation capacity requires fresh
  saved-plan acceptance. The agenda names each active slice and its approved early-development
  exception separately from the full parent's remaining acceptance prerequisites.
- **Pinned dependencies and evidence.** Open an imported map in **Roadmaps** and expand
  **Dependency environments and evidence**. Inspect bound Git refs and their Cargo package mappings,
  use **Set up dependencies → Discover local setup** to propose required upstream relationships,
  exact commits, conformance identities, and local environment fingerprints. Review captured
  workstation, imported fixture-source, and installed Rust toolchain inputs before explicitly
  saving a generation. Discovery never approves a checkpoint or starts work. Advanced manual
  setup remains available; external native/Kata qualification uses separate environment and
  tested-fixture identities, not the local discovery fingerprints.
  Each scoped run receives its own source snapshots and Cargo launcher. The launcher rejects
  dependency fallback and records clean-commit builds. Independent contract/domain scopes require
  successful scoped checks; integration/conformance/release scopes retain current upstream builds. Frozen build records survive cleanup and are downloadable from the map.
  Independent Cargo checks in an integration run use that same launcher and produce supplementary
  receipts; they do not replace a successful build against the pinned upstream packages.
  Use the subject-specific JSON template or upload an evidence package with real logs, exact case
  hashes and independent reviewer attestations. Inspect its readable artifacts and explicitly
  accept or reject it with a rationale. After a provider advances, pause scheduling and use
  **Preview dependency refresh**. Review the exact commits, retained evidence and required fresh
  reviews, then explicitly apply. Unchanged consumer inputs preserve applicable evidence and
  unchanged host/environment inputs preserve workstation approval. Accept new saved-plan evidence
  before Resume; affected completed reviews and first reviews blocked before launch are queued
  automatically with their original reviewer and worktree, and an existing owning-slice
  recovery keeps its repair round. Historical receipts retain their original generation. Native
  results cannot satisfy actual-Kata requirements. External host execution
  is not dispatched by this version; checkpoint decisions and final promotion remain separate.
- **Cross-project supervision.** In **Roadmaps**, open an imported map, explicitly choose a
  target, then select **Only target prerequisites** or **Full roadmap; prioritize this target**.
  Inspect **Selected work by project** (ownership groups, not scheduling order). Each parent
  exposes cross-project requirements grouped by start, merge, verification and acceptance.
  The focused dependency graph expands checkpoint chains to provider work items; **Show in project**
  opens and focuses the provider. Startup notices open their resolution controls, and **Preview
  launch readiness** shows clear phase gates and the reasons other slices wait. Finalization
  and publication indicators describe eventual completion, not startup prerequisites.
  Adopt the exact map's scheduling proposals with a rationale; independently reviewed checkpoint
  evidence remains separate. Set roadmap profiles/policy defaults, optional project/activity/individual
  overrides, explicit independent reviewer responsibilities, parallel development limits, integration
  policies and parent-acceptance policy. Unassigned specialized reviewer roles remain evidence gates.
  **Create cross-project roadmap** saves a draft. **Saved plan acceptance** shows the saved revision
  and missing setup. Use **Generate plan-acceptance evidence** to collect the saved map/source hashes,
  exact bindings, adopted decisions, pins, reviewer settings and resources. Inspect the generated
  artifacts, confirm your review as stack-integration-owner, and explicitly **Accept evidence** with
  a rationale. Generation does not approve the plan. Changed saved settings or runtime require a
  fresh package and review. **Start roadmap** or **Resume roadmap** separately delegates execution;
  unresolved `STACK-PLAN-ACCEPTED` now appears in the startup requirements.
  Development cycles, independent verification and parent acceptance progress under their phase gates.
  Parent acceptance defaults to manual; automatic acceptance still requires all original obligations
  and a fresh independent review. Review snapshots never implement fixes. **Independent review
  recovery → Configure review recovery** optionally delegates a bounded repair/integrate/reverify/
  retry-parent loop. Pause scheduling to enable it and choose a total round allowance per parent,
  then Resume explicitly. Saving this execution delegation does not change saved plan acceptance.
  Repairs retain the owning slice's models, remediation and integration policies; rounds persist
  across worktrees and restarts. Genuine questions, uncertain ownership, repeated unchanged findings
  and exhausted allowances return to you. Manual owning-slice recovery remains available. Current review snapshots fast-forward after integration
  changes and get a fresh review. Started attempts keep their settings; pause to edit queued settings.
  Trace blocked EXO work to its supplying WI slice/checkpoint and open the relevant work item or evidence
  controls. Eligible checkpoint evidence gets durable Pushover reminders; ordinary dependency waits do not.
  Target reached, selected scope complete, all parents accepted, finalized and published are distinct.
  **Planning amendments and reconciliation** previews an exact replacement binding or a new target
  in the same roadmap. Import revised plans inactive, configure their branches and bind the new map;
  then propose the change, inspect its impact and apply/reject with a rationale. The roadmap pauses
  and waits for affected sessions; applying preserves retired attempts, branches and completed history.
  Explicit reuse carries eligible integrated code only. New definitions need new adoption and evidence;
  current-binding reconciliation reruns stale verification and parent acceptance. Resume explicitly.
  **Project finalization readiness** links each complete original plan to staged finalization. It freezes
  the map, integration snapshot and runtime; changed pins require a new finalization. No target or
  roadmap policy approves final promotion. After promotion consumers explicitly repin to the recorded
  destination and reassess evidence. Publication remains separate. Native/Kata execution remains external.
- **Historical baseline preparation.** An idle design recovery offers **Prepare baseline evidence**.
  Review exact bound application baselines and the retained upstream pre-redesign tag, then explicitly
  prepare local baseline tags and source snapshots. Existing tags are never moved or published.
  Sources live under configured worktree storage (`.baselines`); shared downloaded Cargo packages use
  `.historical-cargo` there. Bounded design recovery receives fresh isolated sibling copies and a separate
  historical Cargo launcher with original lockfiles, retained command receipts and failure logs.
  **View historical collection logs** exposes bounded previews in the browser. Historical build targets
  use registered run scratch and normal post-run cache cleanup; source snapshots and the shared registry
  cache are retained. Preparation does not start a run or approve evidence. Architecture, implementation
  choices, ownership and remote protection policy remain operator decisions. Independent scoped candidate
  checks can use these exact historical dependencies without repinning the target runtime; integration
  and finalization still require current upstream builds. New run briefs and design recovery facts
  name the selected verification policy.
- **Local CI.** Scoped runs receive `ct-check` for repository scripts and `ct-act` for a selected
  GitHub Actions workflow/job. An optional rootless Docker installation supplies a digest-pinned
  Rust runner, exact dependency mounts, shared download caches and retained execution logs.
  CI is bounded and cleans run-owned containers; build targets use post-run scratch cleanup.
  See [local CI setup](scripts/local-ci/README.md). Configuration never resumes paused work.
- **Repositories.** Register any local Git checkout by path.
- **Plan branches.** Open **Projects → a plan → Repository & branches** to select a
  registered repository and an existing integration branch, or explicitly create one
  from another local branch. Settings apply to future worktrees for that plan version.
  Existing plans need no reimport; existing worktrees can adopt or retarget a branch
  explicitly without rewriting their starting history.
- **Worktrees.** Create a linked worktree on a fresh `ct/<item>-<id>` branch for a work
  item, and remove it when done. The primary checkout is never touched by an agent.
- **Agent runs.** Launch Claude Code or Codex in the worktree with a composed brief (the work
  item, its dependencies, the plan documents, your instructions). Choose a role
  (implement, review, design), a permission posture, and optionally a model. Runs
  record resolved models and billing information. Codex also records turn token usage;
  dollar usage is shown only when the account reports it.
- **Live supervision.** Every tool call, result, message, and turn is journaled and
  streamed to the browser into a feed you can filter and scroll without losing your
  place. The final outcome appears above activity, with the full recorded message available
  separately from raw events. Send follow-up messages, end the session, or cancel.
- **Diffs.** See commits, changed files, and the unified patch of the worktree against
  its base at any time.
- **Review-gated merge.** A review run ends with a verdict. When the latest run on a
  worktree is a review that returned `mergeable`, the daemon offers Merge into its
  recorded integration target: a merge commit, the worktree removed, the branch deleted, and
  the work item completed, in one step. The primary checkout is never disturbed; when
  it is not on the target the merge happens in a scratch worktree. Any later run closes
  the gate again.
- **Integration updates.** Each review records the item commit and integration commit.
  If either changes, merge approval expires. End sessions and pause the cycle, use
  **Update from integration**, then verify and review manually or resume the cycle for
  a fresh review. Updates use normal merges and abort on conflict. Item diffs exclude
  integration work already present in the item's ancestry. Parallel roadmap cycles automate
  that update and fresh review at safe step boundaries. Required predecessors must
  have integration commit evidence; plan settings can attach evidence to older manual
  completions without changing their completion history.
- **Integration conflict resolution.** An automated cycle with integration conflicts offers
  **Resolve integration conflicts**. Select an agent/model and instructions; the daemon
  prepares the pinned merge, the agent resolves and stages files and runs checks, and the
  daemon commits the update before a fresh review. Older failures use **Inspect integration
  conflicts** first. Pause to guide the agent from its run page; end its session before
  resuming. Failed attempts retain edits and allow up to three agent attempts. **Abandon
  resolution** aborts the pending merge and discards its resolution; unrelated edits may
  remain, and untracked files are preserved.
  Restart requires explicit resume. Stop preserves an owned resolution until it is resumed
  or abandoned. Final merge into integration remains your action.
- **Remediation and findings.** A review's findings can be handed straight to a new
  implement run in the same worktree. Handoffs include the recorded conversation across
  the run lineage, including earlier messages and operator corrections, plus the full
  recorded final messages. The inline preview allows 256 KiB; source files are not
  clipped to that preview. Known upstream truncation is flagged explicitly.
- **Automatic worktree housekeeping.** New runs get temporary space outside Git. Automated
  implementations checkpoint tracked edits and explicitly staged new source before review;
  unknown files go to bounded remediation for classification. Negative reviews hand off
  findings even when verification leaves artifacts. Dirty positive reviews require cleanup
  and a fresh review. Final merge remains your decision. Scratch files remain under each
  run's directory for inspection (they are not automatically pruned).
- **Background completion recovery.** The controller keeps Claude connected while background
  work awaits collection. If Claude exits before collecting it,
  the daemon holds the worktree until its process group finishes, bounded by the original
  step deadline. It then allows up to two same-step continuations to collect verification
  and finish reporting, without consuming remediation attempts or extending the deadline.
  Interrupted reviews can inspect and preserve leftover test artifacts on their unchanged
  branch baseline; tracked edits and changed commits block this path. **Resume finalization**
  also uses this recovery path, with optional guidance.
  Incomplete exits appear above the run outcome and cannot close findings or enable merge.
  Questions, exhausted recovery and restart still require operator action. Existing runs
  retain their recorded outcomes; this applies to newly launched runs.
- **Consolidated review reports.** Reviewers finish with a structured report containing
  stable finding IDs, severity, location, explanation, suggested fix, and reviewer-owned
  open/resolved/withdrawn status. The run page counts open findings and retains closed
  ones with their dispositions. Work-item reports retain prior IDs in their handoff
  lineage; finalization reports may omit findings already closed by a valid review. Invalid reports cannot supply a merge verdict; legacy unstructured reviews
  remain usable manually, with their conversation included in handoffs.
- **Independent-review source recovery.** On a paused verification or parent review,
  **Automation → Source changes required** shows open findings from related independent
  reviews. **Delegate fixes to owning slice** prepares an editable slice worktree from
  current integration and starts a focused remediation/review cycle using its previous
  implementation settings and an explicit follow-up allowance. Findings from separate
  reviews retain distinct IDs even when their original IDs match. Approve the repaired
  slice's integration merge in **Delegation**, resume the existing verification review,
  record its verification, then resume and accept the parent review. Resume updates clean
  independent snapshots from integration even while the roadmap is paused. Recovery does
  not resume roadmap scheduling or delegate its integration merge. Old review questions
  remain in history; reviews waiting on prerequisite work do not produce duplicate
  header attention or push reminders.
- **Automated work-item cycles.** On an admitted, unblocked item's page, create a
  worktree and open **Automated cycle → Set up a cycle**. Choose each step's agent,
  model, and permissions; the daemon runs design → implement → review → remediate,
  stopping for your merge approval. Design advances only with an explicit `none` in
  its final Open questions section. Completion requires zero open blocking, major,
  or minor findings, and a configurable nit allowance (default 3). Remediation rounds
  and step time are bounded; incomplete reports, failures, and stalled reviews pause
  for attention. Pause/resume supports manual intervention; stop returns the worktree
  to the manual flow. An exhausted review shows **Continue remediation** in the item's
  **Automated cycle** section, including slice cycles launched by roadmaps. Choose 1–20
  additional attempts, optionally add cycle guidance, and select **Authorize more remediation**.
  This immediately delegates the next remediation, preserving the initial policy, findings,
  worktree, agent settings, and round history; it does not resume a paused roadmap. A valid,
  completed review is required; answer open questions in the guidance before authorizing recovery.
  Implementation and review questions stop immediately. With allowance remaining, questions and
  stalled reviews show **Continue with guidance**: supply answers or a changed approach to continue
  without increasing the budget. Recovery preserves report, conflict and independent-review gates.
  Other cycle settings stay fixed after start. Workspace notices persist
  across reloads, and daemon restart requires explicit resume. Review and merge check
  the reviewed source and target commits. Standalone cycles stop for your merge approval;
  roadmaps can delegate integration merges explicitly.
- **Roadmaps.** Open **Roadmaps** to select and order imported work items,
  set each step's agent/model/permissions and completion policy, then save and explicitly
  start. The daemon admits eligible items, creates worktrees from their bound integration
  branches, and delegates existing automated cycles. Each completed integration merge releases
  the next eligible item. Dependencies outside the roadmap and existing unmerged worktrees remain
  visible blockers. Pause supports manual work and queued edits; immutable revisions
  retain started settings and execution history. Restart requires explicit roadmap resume.
  Sequential mode preserves strict order. Parallel mode uses order as priority, with bounded
  in-flight items, repository capacity, and per-entry exclusion groups. Items needing attention
  pause independently. Sibling merges trigger an idle worktree update and fresh review; conflicts
  and exhausted recovery budgets require attention. **Integration automation** separately controls
  automatic merges and agent conflict resolution, with manual defaults and per-item overrides.
  Started items retain the policy from their saved revision. Automatic merges retain the same
  clean-worktree, findings, fresh-review, and exact-commit gates. `main`, `master`, repository
  defaults, finalization destinations, and additional protected branches always require approval.
  Choose additional protections in the plan's **Repository & branches** settings.
- **Plan finalization.** Open **Projects → project → plan version → Finalize integration** after
  all plan items are integrated. New finalizations default to five **Focused stages**:
  correctness, conformance, simplification, polish, and final independent review. Configure
  each stage's review/implementation agents, instructions, required check names, initial
  remediation budget (0–20, default 3), and run timeout. Correctness and conformance can have
  work-item slices before their mandatory whole-plan cross-boundary check. Repository-required
  checks always apply; the final independent review runs the full checks.
  Correctness/conformance findings and all blocking/major findings require remediation at every
  severity. Simplification and polish discover optional minor/nit improvements once, then pause
  for your selection. Select any or none, record a rationale, and add attempts if needed. Only the
  selected batch is implemented and verified; new optional ideas stay open as visible follow-up
  work. A narrower recovery batch never drops other originally selected findings. Later required
  issues can reopen correctness or conformance, retaining its spent budget and requiring a new
  final independent review. Stage allowances are separate from work-item and roadmap settings.
  The stage view shows current scope, selected IDs, progress, allowances, follow-ups, decisions,
  and a durable obligation-to-evidence ledger seeded from imported work-item exit gates. Reviewers
  add individually cited obligations from plan prose. Existing obligation updates use ID, status
  and concise evidence instead of repeating requirement text. Explicit proposed plan adjustments
  require your approval and rationale, then fresh verification; they never waive required checks.
  Prior evidence is reusable outside the final review only from a completed stage at matching
  candidate/destination commits with unchanged requirements and evidence. Final review revalidates
  every obligation. Closed findings and unchanged retained follow-ups remain in the handoff ledger
  without being repeated in each final message. Invalid reports cannot authorize promotion.
  **Next finalization step** unifies batch selection, plan-adjustment decisions, recovery and
  answers/guidance. **Authorize focused remediation** adds 1–20 attempts and starts the selected
  recovery batch even when the current stage is exhausted. A required review without selectable
  findings offers **Authorize more remediation**. **Resume with guidance** retries the current step
  without granting attempts, approving plan changes or selecting optional work. Open questions
  always require answers. **Recovery agent → Agent settings** switches backend/model for this
  recovery and remaining runs, or restores each stage's original profiles; permissions are retained.
  Decisions, evidence, stage progress, selected batches, usage and model overrides survive restart.
  **Legacy improvement rounds** remains available for new and existing manual workflows. Its
  shared finalization budget, scheduled polish passes and exact-commit nit deferrals retain their
  prior behavior. See [the finalization roadmap](docs/finalization-roadmap.md) and ADR-042.
  Pausing retains the integration hold; stopping
  releases it and retains the candidate for inspection or removal.
  Finalization works on a dedicated candidate branch from a pinned integration snapshot.
  Further daemon merges into that integration branch wait until finalization ends. Review
  the full candidate diff and run outcomes, then explicitly approve the exact candidate and
  destination commits. The polished candidate merges directly into the final destination;
  the source integration branch remains at its snapshot unless you select **Remove local
  integration branch after successful promotion** in the final approval. Completed attempts
  also offer **Remove integration branch** and retry cleanup, including older promotions.
  Removal is local only, refuses changed, protected, checked-out or shared branches, and never
  reopens a successful promotion. Plan/project headers, project cards and version history show
  **Plan completed** with the destination and recorded merge. Completion belongs to that plan
  version; new versions do not inherit it. External integration drift requires
  a new finalization. No stage, round count or roadmap policy can approve final promotion.
- **Merge recovery.** Merge reservations survive interruptions between Git and database
  completion. Recovery checks the recorded commit and parents before recording completion,
  without repeating a completed merge. Cleanup follows completion; failed cleanup remains
  visible with **Retry worktree cleanup**, and later edits or commits are retained.
- **Design handoff.** A finished design run can be accepted with one click: the implement
  run that follows gets the proposal as its plan. Design runs end with their open
  questions so the operator sees what still needs a decision before accepting.
- **Agent profiles.** Workspace settings hold the agent, model, and permissions each run
  role starts with, so design and review can live on one agent and implementation on
  another. The launch form and every handoff pre-fill from the profile for the target
  role and let each launch override it. Every edge of the loop has a handoff button:
  Implement on a finished design, Review on a finished implementation, Remediate on a
  review with a verdict.
- **Phone supervision.** A compact navigation menu, larger touch controls, wrapping
  findings and branch names, and contained table/diff scrolling support checking
  cycles, steering runs, and explicitly approving merges from a phone browser.
  Work-item links preserve their destination through sign-in.
- **Workspaces and account.** Several workspaces per user, created and renamed from the
  browser; password change from the account page; dark theme by default with a light
  option.
- **Durability.** Runs, events, worktrees, and repositories live in SQLite. A daemon
  restart marks runs that were live as interrupted; nothing is lost.

Not yet: a Planning Studio editor, remote qualification execution,
email/SMS notifications, additional backends, or interactive permission prompts.

The agreed [cross-project concurrency roadmap](docs/cross-project-roadmap.md) records the
six delivered increments, including reviewed amendments and the shared Planning Studio validation seam.

Pushover notifications are configured per workspace in **Settings**. Owners can save
write-only credentials, choose merge/attention alerts, send a test, and inspect delivery
status. Reminders persist across restarts: immediately, +30 minutes, +1 through +6 hours,
then daily at 21:00 in the configured timezone (default America/Los_Angeles).

## Quickstart on the workstation

Prerequisites: pnpm 10 (see [`CONTRIBUTING.md`](CONTRIBUTING.md)), Git 2.32+, and
[Claude Code](https://code.claude.com) installed and signed in (`claude` on PATH or
in `~/.local/bin`), or Codex installed and signed in (`codex login`). Node 24 is
downloaded by pnpm automatically.

```sh
pnpm install
pnpm db:migrate
pnpm craftingtable admin bootstrap --username keith   # prompts for a password
pnpm dev            # daemon on http://127.0.0.1:4600 + Vite UI on http://127.0.0.1:5173
```

Sign in at http://127.0.0.1:5173, import a plan (or use `fixtures/plan-bundles/aq-cont-1`
to try it), open **Repositories** and register a checkout, open a work item, admit it,
configure the plan’s integration branch, create a worktree, launch an implement run, then a review run, then merge.

Forgotten password: run `pnpm craftingtable admin reset-password --username keith`
on the workstation as the daemon's OS user. It prompts for a new password twice,
preserves your data, and revokes existing login sessions. Use the daemon's data-directory
environment if you configured a custom location; the command prints the database path.

Upgrading from an earlier build: `pnpm db:migrate` applies schema 22 (the daemon also
migrates on start). Existing runs and their event journals are preserved.

`pnpm check` is the CI-equivalent local gate (format, lint, types, build, unit tests,
browser end-to-end tests with a scripted agent, and the forbidden-scope check).

## Storage and disk space

**Settings → Storage** shows the actual database, worktree, run-file and backup locations
with filesystem capacity. Scan for categorized usage and preview cleanup. An owner of every
active workspace can change future worktree/run placement and backup location without moving
existing work. The installation-wide settings persist in SQLite; environment worktree/run roots
seed the settings on first startup. Whole-data relocation is an offline operation.

Recognized Cargo caches are cleaned after each finished, failed or cancelled run, once its
worktree has no live sessions. Both backends give each run its own Cargo target directory;
subsequent builds may take longer because they rebuild those caches. Automation waits for
post-run cleanup before advancing that worktree. Other scratch still expires after 30 days
following merge and worktree removal, with an option to retain it. Active sessions and runs
interrupted by daemon restart stay protected. Run messages, findings, plan files and database history remain. Daily consistent
SQLite backups retain seven snapshots by default; put them on another disk for drive-failure
protection. They do not back up source repositories or unmerged worktrees.

New runs and worktrees require the configured free-space reserve (5 GiB by default). Existing
notification preferences cover disk-pressure and maintenance alerts. This is a launch guard,
not a quota on a running agent. See [storage operations](docs/operations.md#storage-maintenance)
for cleanup limits, backup coverage, restore and migration.

## Using it from the couch

The daemon can serve the built browser app itself and listen on the LAN, but only over
TLS: the session cookie is marked `Secure`, and the daemon refuses to bind a
non-loopback address without a certificate or an HTTPS public origin fronted by a proxy.

If the laptop and the workstation are already on a Tailscale tailnet, the easiest route
is to leave the daemon on loopback and let `tailscale serve` terminate TLS in front of
it: a real certificate, nothing opened on the LAN interface, and reachable from a phone
later. That setup is in [`docs/operations.md`](docs/operations.md); the rest of this
section is the direct-LAN alternative.

Serving the LAN directly needs a certificate of your own, and the simplest is a
self-signed one for the workstation's LAN name:

```sh
mkdir -p ~/.config/craftingtable
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=workstation.lan" -addext "subjectAltName=DNS:workstation.lan,IP:192.168.1.20" \
  -keyout ~/.config/craftingtable/key.pem -out ~/.config/craftingtable/cert.pem
```

Then build once and start the daemon with the LAN settings:

```sh
pnpm build
CRAFTINGTABLE_HOST=0.0.0.0 \
CRAFTINGTABLE_PORT=4600 \
CRAFTINGTABLE_PUBLIC_ORIGIN=https://workstation.lan:4600 \
CRAFTINGTABLE_TLS_CERT=$HOME/.config/craftingtable/cert.pem \
CRAFTINGTABLE_TLS_KEY=$HOME/.config/craftingtable/key.pem \
pnpm start
```

Trust the certificate on the laptop once (or accept the browser warning), then open
https://workstation.lan:4600. The public origin must match the URL you type exactly;
it is what the CSRF and origin checks compare against. A `systemd --user` unit with these
variables in an `EnvironmentFile` keeps it running; see
[`docs/operations.md`](docs/operations.md).

## Configuration

All settings are environment variables. Defaults suit the loopback dev setup.

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_HOST` | `127.0.0.1` | Listen address. Non-loopback requires TLS or an HTTPS origin. |
| `CRAFTINGTABLE_PORT` | `4600` | Listen port. |
| `CRAFTINGTABLE_PUBLIC_ORIGIN` | `http://127.0.0.1:5173` | The origin the browser uses; drives CSRF, origin policy, and cookie security. |
| `CRAFTINGTABLE_TLS_CERT`, `CRAFTINGTABLE_TLS_KEY` | unset | PEM files; set both to serve HTTPS directly. |
| `CRAFTINGTABLE_WEB_DIST` | `apps/web/dist` if built | Built browser app to serve from the daemon. |
| `CRAFTINGTABLE_DATA_DIR` | `~/.local/share/craftingtable` | SQLite database, worktrees, and run briefs live below this. |
| `CRAFTINGTABLE_WORKTREE_ROOT` | `<data>/worktrees` | Where linked worktrees are created. |
| `CRAFTINGTABLE_RUNS_ROOT` | `<data>/runs` | Per-run brief and plan documents handed to the agent. |
| `CRAFTINGTABLE_GIT_EXECUTABLE` | first `git` on PATH | Absolute path override. |
| `CRAFTINGTABLE_CLAUDE_EXECUTABLE` | first `claude` on PATH or `~/.local/bin` | Absolute path override. |
| `CRAFTINGTABLE_CODEX_EXECUTABLE` | first `codex` on PATH or `~/.local/bin` | Absolute path override. |
| `CRAFTINGTABLE_CODEX_MODELS` | built-in Codex model list | `id=Label,id=Label` entries for the model picker. |
| `CRAFTINGTABLE_CLAUDE_MODELS` | built-in list (`opus`, `sonnet`, `haiku` aliases plus current ids) | `id=Label,id=Label` entries for the launch form's model picker. |
| `CRAFTINGTABLE_DIFF_LIMIT_BYTES` | 4 MiB | Ceiling on one diff response's patch text. |
| `CRAFTINGTABLE_SESSION_LIFETIME_SECONDS` | 30 days | Browser session lifetime. |
| `CRAFTINGTABLE_LOG_LEVEL` | `info` | pino level. |

The **Repositories** page shows which Git, Claude Code, and Codex executables the daemon found.

Codex uses its documented app-server integration over local stdio (verified with CLI
0.153.4). Sign in as the daemon's OS user with `codex login`; subscription login works.
Auto uses the workspace-write sandbox with Codex automatic approval review. Edit-only
denies requests to expand access; Unrestricted disables the sandbox and approval checks.
Follow-ups steer an active turn or start another turn in the same thread. End session
finishes accepted input; Cancel interrupts and terminates the process group. Codex does
not enforce dollar budget caps. Dollar estimates may be unavailable on subscription
accounts; missing costs appear as `—`, never as zero.

## Where things are

- `apps/server` Fastify daemon: auth, workspaces, planning, execution services and routes.
- `apps/web` React browser app; a projection of the daemon's state, never the source of truth.
- `packages/domain` durable vocabulary; `packages/contracts` runtime-validated wire schemas;
  `packages/storage` SQLite and migrations; `packages/planning` plan-bundle parsing.
- `packages/git` Git operations (worktrees, diffs) behind a process-authority module.
- `packages/agents` the agent backend seam, shared process supervision, and Claude Code and Codex adapters.
- `docs/` architecture, security, operations, and ADRs. `AGENTS.md` is the guidance for
  anyone (human or agent) changing this repository. `init/` is the original planning
  package, background only. `archive/` holds superseded process artifacts.

## Non-goals

CraftingTable is not a coding agent, an IDE, a general workflow engine, a hosted product,
a browser shell, or a replacement for Git or GitHub, and nothing here is a runtime
dependency of the projects it supervises.

> Do not finish CraftingTable before using CraftingTable.

### Resolving design questions

An idle design cycle offers **Resolve design questions**. Open it from the work item's
Automated cycle section; an existing slice links to that cycle, and a finished design run
links back to recovery. Discovery reads the recorded questions, saved branch/dependency
identities and matching documents from the exact bound plan versions and preserved ZIPs.
Inspect the hashes and source text, enter answers, and optionally attach up to four small
text files. Choose the backend/model for this recovery without changing the cycle's other
step profiles or permission posture.

**Start bounded investigation** runs one design attempt and always stops for your review.
**Continue design with evidence** resumes design and advances only when its final Open
questions section says `none`. Both reuse the worktree, preserve the complete handoff and
use the cycle's step timeout without spending remediation attempts. Changed context requires
fresh discovery; restart requires explicit recovery. Discovery and investigation do not
approve checkpoints, invent measurements, create/publish tags, change branch protection or
merge. Repository administration and genuinely missing historical evidence remain explicit
requirements. Manual handoffs and their subsequent adoption through Resume remain available.

Shared ADR approvals live in **Roadmaps → Dependency environments and evidence → Shared
architecture decisions**. Prepare a proposal with exact decision text and source references;
optionally attach a completed design. Saving never approves it. Pause scheduling, finish live
runs, open **Review decision packet**, review the artifacts and record your authenticated
repository-maintainer approval. Relevant subsequent runs receive the approved choice.

For an ADR with early definition clauses, choose **Early clauses for named slices**, state the
remaining obligations, and name each consumer and its start/merge gate. The preview explicitly
identifies full-checkpoint substitutions and new prerequisites. A later full-checkpoint consumer
must remain. Approval requires fresh saved-plan acceptance before execution. Return to design
recovery, refresh evidence, and choose **Continue design with evidence**. Architectural choices
and clause staging always require your decision; no agent recommendation grants authority.

New designs classify cited plan answers, mapped predecessor waits, operator decisions and
planning conflicts. Exact mapped waits survive restart and may trigger at most two automatic
design rechecks after prerequisites clear; they retain their worktree and roadmap reservation.
Pausing the roadmap prevents these rechecks. An unrecognized dependency is a planning question,
and an explicit bounded investigation still stops for review. Approved choices invalidate only
relevant review provenance when changed; existing unrelated predecessor receipts remain usable.

## Managed native verification

In **Roadmaps → Dependency environments and evidence → Verification environments**, use
**Audit workstation readiness**, review the captured host/toolchains/limits, and explicitly
**Approve native verification** with a rationale. This authorizes non-sensitive repository
fixtures for the exact map binding and dependency generation. It does not change pins or
approve tests. Running roadmaps automatically dispatch eligible native verification reviews;
paused roadmaps remain paused. Missing environment approvals generate attention reminders
once their verification step is otherwise eligible. Occupied slots retry without alerts.

Independent reviewers receive `ct-native`, which retains exact-commit evidence under bounded
user-service execution. Ordinary development/act results cannot satisfy native verification.
Revoking approval prevents acceptance/reuse of affected native reviews. The audit separately
shows installed Kata/KVM and any configured root-owned guest smoke receipt; Kata dispatch and
application qualification remain separate. See [Kata setup](scripts/kata/README.md) and ADR-054.

If a scope also reports missing reviewer qualifications, use **Assign independent reviewer
responsibilities** to open queued roadmap settings. Assign the source-required roles to the
configured independent reviewer, save, and refresh saved-plan acceptance if prompted. Environment
approval never assigns reviewer responsibilities or claims those obligations were satisfied.
