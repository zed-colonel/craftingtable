# CT-04A design review

Reviewed proposed plan: `work-items/CT-04/CT-04A-proposed-implementation-plan.md`
sha256 `575df9d9caf427661696f747f6083dc8fa6adce81a3a7785db125b6b8791ddcb` (untracked at review time)
Source baseline (pinned): `abc5f37815ad76430cae989224afde817d77a047`
Review checkout: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`, branch `ct-04a-git-foundation`
Protected spec observed: `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64` — matches the plan's claim.

## Verdict

**FAIL**

This is a narrow fail, not a rejection of the approach. The plan is the strongest Phase A artifact this repository has produced: the three-command Git surface, the constructed-rather-than-scrubbed environment, the double admission, the primary-checkout-only `.git` test, and the `MATCH SIMPLE` null-coupling analysis are all correct and well-argued. It fails because (a) two declared facts are provably wrong against the checkout, (b) the identity state machine as designed converts a routine environmental event into an irreversible loss of bindings, and (c) a state change is committed with no workspace event, which breaks the CT-03 snapshot-plus-cursor reconstruction contract. (a) is mechanical; (b) and (c) change schema columns and the event catalog, so the revised plan should return for a short re-review rather than going straight to accepted.

## Findings

### F-01 — Blocking — The protected-spec verification gate fails today, before any code

- **Claim.** §17's gate command `git diff --exit-code abc5f37815ad76430cae989224afde817d77a047 -- protected/CT-04-protected-acceptance-spec.yaml` cannot pass, because the protected spec did not exist at the pinned source baseline.
- **Evidence.** `git log --all -- protected/` shows the directory was introduced by `06abcff` ("CT-04: add decomposed source-grounded package"), a descendant of `abc5f37`. Running the plan's exact command now exits `1`, with `git diff --stat abc5f37 -- protected/` reporting `1401 insertions(+)` across both protected files.
- **Violated.** P-PROCESS-004, CT04-I25, process protocol §8.
- **Required plan change.** Pin the protected-spec comparison to `06abcff` (the commit that introduced the protected package), not to the source baseline. Keep the `sha256sum` probe and state the expected literal digest `ce7a101c…f090f64` in the accepted plan so the gate is self-checking rather than eyeballed. State both the baseline SHA (for source reconciliation) and the protected-package SHA (for immutability) as two distinct pins throughout.
- **Suggested adversarial case.** A permanent gate step that fails if `git diff --exit-code <protected-pin> -- protected/` is non-empty *and* a negative probe that deliberately mutates one `expected:` line in a scratch copy and proves the gate rejects it. Without the negative probe, a gate that always passes for the wrong reason is indistinguishable from one that works.

### F-02 — Blocking — The declared target file tree omits files the design provably forces; "no browser surface" is false

- **Claim.** Registering three new workspace-event kinds in the shared contract union mechanically breaks three exhaustive `switch` statements and one storage mapper. None of the four files appear in §13, and §8 asserts "There is no browser UI in CT-04A."
- **Evidence.** `tsconfig.base.json` sets `"strict": true`. The following are exhaustive switches over the event-kind union with no `default` arm, so a new member is a compile error, not a silent fallthrough:
  - `packages/storage/src/repositories/workspace-events.ts:64` — `mapEvent(row)` returns `WorkspaceEvent`;
  - `apps/web/src/lib/workspace-projection.ts:87` — `invalidatedBy(event, current)` returns `StaleScopes`;
  - `apps/web/src/components/ActivityPanel.tsx:5` — `describeEvent(event)` returns `string`.

  `packages/contracts/src/workspace-event.ts:71` is a `z.discriminatedUnion('kind', …)`, and `apps/web/src/lib/workspace-projection.test.ts:153` asserts on concrete kinds. §13 lists `packages/storage/src/repositories/repository-registry/index.ts` but not `repositories/workspace-events.ts`, and lists no `apps/web/**` file at all.
- **Violated.** Process protocol §4.2 and §4.12 (target file tree, predicted scope); CT-04A exit gate "All CT-01 through CT-03 tests still pass."
- **Required plan change.** Add `packages/storage/src/repositories/workspace-events.ts`, `apps/web/src/lib/workspace-projection.ts`, `apps/web/src/lib/workspace-projection.test.ts`, and `apps/web/src/components/ActivityPanel.tsx` to §13, and replace "There is no browser UI in CT-04A" with the accurate statement: CT-04A adds no repository *views*, but it necessarily extends the browser's event projection and activity rendering. Explicitly forbid closing the three switches with a permissive `default:` arm — the exhaustiveness is the mechanism that stops a future kind from silently entering the journal unprojected. State what `invalidatedBy` returns for each repository kind (which authoritative queries go stale) rather than leaving it to implementation.
- **Suggested adversarial case.** A permanent test that a workspace containing repository events still produces a correct CT-03 dashboard projection, plus a compile-level guard (`assertNever`) in each switch so a CT-04B kind added without a projection decision fails the build rather than rendering as blank activity.

### F-03 — High — The Git version floor is below the floor the plan's own environment profile requires

- **Claim.** §5.1 sets the floor at 2.31.0 "for `rev-parse --path-format=absolute`", but §5.3 depends on `GIT_CONFIG_GLOBAL`, which Git only honours from 2.32.0. On 2.31.x the variable is silently ignored and the operator's real global config is read.
- **Evidence.** `--path-format` landed in 2.31.0; `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` landed in 2.32.0. §5.3 also relies on `HOME` being absent as a second layer, which happens to suppress global config on Linux via `home_config_paths()` — but the plan states the isolation as guaranteed by the variable, and a defence that works by accident is not a stated invariant. Local Git here is 2.54.0, so a floor bug would not surface in this operator's own testing.
- **Violated.** CT04-I16, CT04-I21, REG-GIT-003.
- **Required plan change.** Raise the floor to at least 2.32.0 and record *why each floor component is required* (2.29 `--show-object-format`, 2.31 `--path-format`, 2.32 `GIT_CONFIG_GLOBAL`), so a later slice cannot lower it. State the `HOME`-absence behaviour as defence in depth, not as the primary control.
- **Suggested adversarial case.** A runner test that writes a global `~/.gitconfig` containing `core.hooksPath`, `diff.external`, and `include.path`, runs the identity and feature commands with the production environment profile, and asserts none of those keys appear in `--local` output and no external program is invoked. Assert the parsed floor rejects a synthetic `git version 2.31.1`.

### F-04 — High — `st_dev` in the terminal identity digest turns a routine remount into irreversible loss of bindings

- **Claim.** §7 makes `dev` and `ino` for both the top-level and the common Git directory part of the immutable identity digest, and makes `identity-mismatch` "sticky and terminal except for Owner retirement." `st_dev` is not stable across mounts for a large class of Linux filesystems, so a reboot can flip every registered repository to a terminal state whose only exit destroys the bindings.
- **Evidence.** Anonymous block-device numbers are allocated at mount time for btrfs subvolumes, overlayfs, ZFS, NFS, and FUSE; they are not guaranteed stable across remount or reboot. The plan's own §9.3 makes Owner retirement atomically retire the repository's active bindings, and §9.1 excludes retired rows from the identity/path partial unique indexes — so recovery is "lose every binding, re-register, re-bind," with a new `RepositoryId` that CT-04B change requests would then not match. §7 also asserts "A platform that cannot provide stable device/inode evidence is rejected at startup," which is not implementable: a daemon cannot detect at startup that `st_dev` will change at the *next* mount.
- **Violated.** CT04-I05 (detection must be meaningful, not noise), CT04-I24 (state must be honest), REG-ID-007 ("identity mismatch **or explicit platform policy**" — the second branch is the one that applies here and the plan does not use it).
- **Required plan change.** Separate the evidence tiers. Treat the Git-derived identity (canonical top-level, canonical common dir, object format) plus `ino` as the terminal-mismatch signal. Treat a `dev`-only change with everything else identical as a distinct, non-terminal `identity-evidence-changed` state that blocks mutation but is clearable by an explicit Owner re-affirmation command, and record `dev` outside the digest (or version the digest so a dev-only delta is computable). If the operator prefers the strict policy, the plan must instead add an Owner "re-affirm identity" transition out of `identity-mismatch` that preserves the row, its ID, and its bindings — retirement must not be the only exit. Delete the unimplementable startup-rejection sentence.
- **Suggested adversarial case.** Simulate a `dev`-only change (inject the stat provider) and assert the repository does not enter a state whose only exit destroys bindings; assert an `ino`-only change and a Git-common-dir change both do produce terminal mismatch. Assert that whatever recovery path is chosen leaves `RepositoryId` and every active binding intact.

### F-05 — High — Retirement, the most destructive CT-04A command, has zero rows in the case map

- **Claim.** §8 adds `POST …/repositories/:repositoryId/retire`, §9.1 and §9.3 give it cascade and identity-releasing semantics, and §11 gives it a transaction order — but §14's case map contains no row for it and §13 names no test that exercises it.
- **Evidence.** §14 maps every REG-PATH, REG-ID, REG-GIT, OWN-REP, JRN-REP, A-*, and P-* case (the ID coverage against `CT-04-acceptance-matrix.yaml` is in fact complete — see Coverage gaps). Retirement is simply not in that matrix, because the predeclared matrices never anticipated it. Its effects are the largest in the slice: it releases the global identity reservation, it cascades to `project_repository_bindings`, and it is the sole exit from `identity-mismatch` (F-04).
- **Violated.** CT04-I03, CT04-I06, CT04-I07; process protocol §4.9–4.10.
- **Required plan change.** Either drop retirement from CT-04A (the slice contract lists it conditionally — "retirement if included") or add an explicit named case group with permanent tests. If kept, the accepted plan must enumerate at minimum: Editor and Viewer receive 403 with zero host access; retirement of a repository with active bindings retires state, bindings, audit, and event in one transaction and notifies once; a second retire request is idempotent with no duplicate event; a retired repository cannot be bound and cannot be inspected back to active; the released path can be re-registered as a new row with a new ID; direct SQL cannot un-retire, delete, or alter a retired row.
- **Suggested adversarial case.** Register one repository, bind it to two projects in the same workspace, retire it, and assert both bindings are retired atomically, both projects are re-bindable only after a fresh registration, and the event journal explains what happened to each (see F-06).

### F-06 — High — Cascading binding retirement commits a state change with no workspace event

- **Claim.** §9.4 registers exactly three event kinds — `repository-registered`, `repository-status-changed`, `project-repository-bound`. §9.3 and §11 retire active bindings as part of repository retirement. There is no `project-repository-binding-retired` kind, so a project's binding disappears from authoritative state with nothing in the journal.
- **Evidence.** CT-03 established snapshot-first reconstruction with a global cursor: `apps/web/src/lib/workspace-projection.ts` derives staleness *only* from received events (`invalidatedBy`, line 87), keyed by `projectId`. A binding retirement emits `repository-status-changed`, whose payload is repository-scoped and whose structural correlation columns carry no project — so `invalidatedBy` has no `projectId` to mark stale and the affected project's view stays stale until an unrelated event or a full reload. A browser holding a snapshot taken before retirement and replaying events after it will never learn the binding is gone.
- **Violated.** CT04-I23, CT04-I07; CT-03 accepted property "snapshot-first browser reconstruction with a global event cursor."
- **Required plan change.** Register a fourth kind, `project-repository-binding-retired`, with a strict payload carrying `projectId`, `bindingId`, and `repositoryId`, correlated structurally via `workspace_events.project_id` exactly as `project-repository-bound` is; emit one per retired binding inside the same transaction; define its `invalidatedBy` contribution. If the operator prefers a single summary event, the plan must instead prove the projection can mark every affected project stale from a repository-scoped payload, and must say how.
- **Suggested adversarial case.** Retire a repository bound to two projects; assert two binding-retired events with correct `project_id` correlation, assert one notifier call after commit, and assert a projection driven only by the post-snapshot event stream marks both projects stale.

### F-07 — Medium — No structural check that a repository-correlated event belongs to the event's workspace

- **Claim.** §9.4 declines to add a `repository_id` correlation column: "Migration 0003 does not rebuild the append-only `workspace_events` journal merely to add nullable correlation columns." Repository identity therefore lives only inside `payload_json`, where nothing constrains it.
- **Evidence.** This is precisely the defect class CT-03 remediation closed. `0002-ct03-planning.sql:557–570` adds a `CHECK (work_item_id IS NULL OR project_id IS NOT NULL)` plus a three-column composite FK into `work_items(workspace_id, project_id, id)`, with the in-file comment recording it as CT03-RR3 — a sibling-project correlation was judged an invariant violation worth a journal rebuild. The proposed design reintroduces payload-only correlation for a *new* resource class and calls the rebuild unnecessary. Note SQLite cannot add a table-level composite FK by `ALTER TABLE`, so "add a nullable column later" is not a cheap escape either.
- **Violated.** CT04-I07 ("…relationships reject cross-workspace and same-workspace/wrong-parent combinations **at the database boundary**"), JRN-REP-005.
- **Required plan change.** Choose and justify one of: (a) rebuild `workspace_events` in migration 0003 with a `repository_id` column and a composite FK to `registered_repositories(workspace_id, id)`, following the 0002 rebuild pattern including the sequence-preservation guard table; (b) add a `BEFORE INSERT` trigger that, for the repository kinds, extracts the payload repository ID via `json_extract` and aborts unless it belongs to `NEW.workspace_id`. Option (a) matches precedent and is what CT-04B/C/D will want anyway for change requests, worktrees, and snapshots — deferring it means four more resource classes accumulate behind the same gap. "Service-layer discipline plus tests" is not an acceptable third option under CT04-I07.
- **Suggested adversarial case.** Direct SQL insert of a `repository-status-changed` event whose payload names a repository owned by another workspace, and one naming a repository that does not exist; both must abort.

### F-08 — Medium — External-execution enumeration misses worktree-scoped config

- **Claim.** §5.2 inspects `git config --local`, which reads `.git/config` only. A repository with `extensions.worktreeConfig=true` can carry `core.fsmonitor`, `core.hooksPath`, or filter definitions in `.git/config.worktree`, invisible to `--local`. `extensions.worktreeConfig` itself is not in the regex.
- **Evidence.** §5.2's regex enumerates `core.hooksPath|core.fsmonitor|diff.external|diff.*.command|textconv|filter.*|include.path|includeIf.*.path`. `--worktree` is a separate scope from `--local`; `--local` does not merge it.
- **Violated.** CT04-I17, REG-ID-008, CT-04A "External-execution features" binding decision ("It may not ignore the question").
- **Required plan change.** Add `^extensions\.worktreeConfig$` to the regex and treat its presence as itself restrictive, or add a fourth fixed command reading `--worktree` scope. Also state explicitly which surfaces the plan knowingly does *not* enumerate and why they are safe under CT-04A's read-only command set — at minimum `.git/modules/*/config` for submodules of an accepted primary checkout, `.gitattributes` / `.git/info/attributes` (inert without a config-defined driver, given global and system config are suppressed), and `.git/config.worktree` if option (a) is chosen. An enumeration whose boundary is unstated cannot be audited in CT-04C when it becomes load-bearing.
- **Suggested adversarial case.** A fixture repository with `extensions.worktreeConfig=true` and `core.fsmonitor` set only in `.git/config.worktree`; registration must classify it `later-mutation-blocked`, not `no-known-external-execution`.

### F-09 — Medium — Dubious-ownership refusal is unmodeled and, under this environment profile, unfixable by the operator

- **Claim.** Git ≥2.35.2 refuses to operate on a repository whose worktree is owned by a different UID unless `safe.directory` allows it. `safe.directory` is only honoured from global or system config, both of which §5.3 suppresses. A repository the operator has already allowlisted in `~/.gitconfig` will therefore fail registration, with no configuration path to fix it.
- **Evidence.** §5.3 sets `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` and does not pass `HOME`. §4's failure discrimination list (configuration, invalid path, unsupported repository class, unavailable, identity mismatch, timeout, overflow, spawn failure, unsupported version, malformed output) has no bucket for it, so it lands in "bounded Git failure" → 503 per §8, which is both the wrong status and an undiagnosable message.
- **Violated.** CT04-I17, REG-GIT-001, REG-PATH exit-gate "fail safely".
- **Required plan change.** Add an explicit `ownership-refused` failure classification, detected from the Git exit and stderr, mapped to a 4xx with an actionable message. State the policy: CraftingTable registers only repositories owned by the daemon's UID, and `CRAFTINGTABLE_GIT_SAFE_DIRECTORY`-style relaxation is deliberately not offered in CT-04A. Record it in `docs/operations.md` alongside the symlink policy, since both are registration rejections the operator will hit before they hit any success case.
- **Suggested adversarial case.** A fixture repository chowned to another UID (skipped when the test runner is root or cannot chown), asserting the classified error rather than a generic bounded-failure 503.

### F-10 — Medium — CT04-I06 is proved only by direct SQL, never through the service

- **Claim.** §14 maps REG-ID-003 solely to `repository-schema.test.ts`: "global active identity/path uniqueness rejects a second workspace directly." There is no server-level case for workspace B's Owner registering a path already registered to workspace A.
- **Evidence.** §14, REG-ID-003 row. §10 promises "Cross-workspace repository and project IDs are never disclosed by conflict details," but no test exercises that promise, and §11's registration flow does not say what the service returns when the in-transaction duplicate recheck hits a *foreign*-workspace row rather than a same-workspace one. §9.3's idempotency rule ("Binding the same repository to the same project is idempotent") has an analogous same-vs-foreign fork at registration that §11 collapses into one "recheck duplicate" step.
- **Violated.** CT04-I06; process protocol §9 ("What is the cross-workspace case?"); source assessment §6 defect class 1.
- **Required plan change.** Split §11's duplicate recheck into its two outcomes and state both: same-workspace active identity → idempotent 200 returning the existing repository, no second row, no second event, no notifier; foreign-workspace active identity → 409 with a body that names neither the other workspace nor the other repository ID. Add both as server-level rows in §14. State explicitly whether a foreign-workspace *retired* row permits registration (it should, since retired rows are excluded from the partial unique indexes) and test it.
- **Suggested adversarial case.** Workspace A registers; workspace B's Owner registers the identical path and receives a 409 whose body is byte-identical to a 409 produced by a same-workspace conflict on a repository the caller cannot see; assert no audit or event lands in workspace A.

### F-11 — Medium — Frozen feature evidence, a misleading table name, and a foreclosed extension point

- **Claim.** §9.2 declares `repository_policies` "immutable and non-deletable" while storing `inspected_at` and registration-time feature evidence. §7 says re-inspection compares identity only — it never refreshes feature evidence. So a repository that acquires `core.hooksPath` after registration displays `no-known-external-execution` forever, and CT-04B/C/D cannot add the policy fields the parent contract §6.2 assigns to `RepositoryPolicy` (allowed target refs, branch prefix, worktree root policy, size limits, submodule representation) without either violating the immutability trigger or creating a second table.
- **Evidence.** §9.2; §7 "An inspection repeats path admission, Git identity inspection, and stat collection" — no feature step. Parent contract §6.2 lists six policy fields, of which CT-04A stores one.
- **Violated.** REG-ID-008, CT04-I17; parent §6.2.
- **Required plan change.** Rename the table to what it is — `repository_registration_inspections` (immutable evidence, correctly frozen) — and state that a mutable `repository_policies` table belongs to the slice that first needs a mutable policy field. Then decide and state one of: re-inspection also re-collects feature evidence and appends a *new* immutable inspection row when it differs (with a status/event consequence), or it deliberately does not, in which case §7's "Any future mutating slice must re-inspect" must become a binding note carried into the CT-04C contract rather than a sentence in a plan CT-04C's implementer may never read.
- **Suggested adversarial case.** Register a clean repository; add a non-sample hook; re-inspect; assert the recorded policy either updates through a new immutable row or is provably surfaced as stale, and that it never silently reports `no-known-external-execution` for a repository that now has hooks.

### F-12 — Medium — No optimistic-concurrency rule for the `version` column

- **Claim.** §9.1 and §9.3 both declare a `version` column with only a "positive version" check. Nothing states that a status transition or a binding retirement must increment it, and no command in §11 reads-then-writes under a version guard.
- **Evidence.** CT-03's precedent is explicit: `0002-ct03-planning.sql:373` requires `NEW.version = OLD.version + 1` inside the single admission trigger, and `audit_events` carries `prior_version`/`resulting_version` columns (`0002…:490–491`) that the repository commands will need to populate. §11's flows say "re-read record" inside the transaction but never say what happens if the re-read shows a different version.
- **Violated.** CT04-I07; CT-03 accepted property "atomic state, audit, and related workspace-event transactions."
- **Required plan change.** State the rule in the migration triggers: every permitted transition must increment `version` by exactly one; no update may change `version` alone; audit rows for transitions must carry `prior_version` and `resulting_version`. Say whether commands are last-writer-wins under the SQLite write lock (defensible for a single-connection daemon) or version-guarded, and test the concurrent case either way. Note that the transition whitelist in §9.1 (`active -> unavailable`, `unavailable -> active`, `active|unavailable -> identity-mismatch`, `active|unavailable|identity-mismatch -> retired`) excludes same-status self-updates, so an inspection that observes no change must issue no `UPDATE` at all — state this, or the trigger will abort on a benign no-op.
- **Suggested adversarial case.** Direct SQL attempting a status change without a version bump, a version bump without a status change, and an `unavailable -> unavailable` self-transition; all three must abort with distinguishable messages.

### F-13 — Medium — The composite membership FK admits revoked members

- **Claim.** §9.1 and §9.3 add "plain existence and composite membership FKs for actor IDs." `workspace_memberships` carries a `status` column, and a composite FK on `(workspace_id, user_id)` cannot see it — a revoked member satisfies the constraint.
- **Evidence.** `0001-ct02-foundation.sql:23–36`: `workspace_memberships` has `UNIQUE (workspace_id, user_id)` (so the FK is structurally possible — a genuine strengthening over CT-03, which used only plain `users(id)` references) and `status TEXT NOT NULL CHECK (status IN ('active','revoked'))`. §15.1's binding-actor row lists "same workspace nonmember rejected" but no revoked-member dimension.
- **Violated.** CT04-I03, CT04-I07; process protocol §9 ("What is the NULL/optional-dimension case?").
- **Required plan change.** State plainly that the composite FK proves *membership existence*, not *active membership*, and that active-membership and role are enforced at the service layer as they are in CT-03. Add the revoked-member dimension to §15.1 for both the repository actor and the binding actor. If the operator wants a database-level active check, it needs a trigger, not a foreign key — say which was chosen.
- **Suggested adversarial case.** An Owner registers a repository, their membership is revoked, and they retry — the service must 404/403 before any host access even though the FK would still accept the row. A direct SQL insert naming a revoked member should be recorded as *accepted* by the database, documenting the boundary honestly rather than implying protection the constraint does not give.

### F-14 — Medium — No unbind or rebind path; correcting a mistake destroys unrelated bindings

- **Claim.** §9.3 states "There is no implicit replace or unbind," and the only route that ends a binding is repository retirement. Binding a repository to the wrong project is therefore corrected only by retiring the repository — which per §9.3 also retires its *correct* bindings to other projects and releases the global identity reservation.
- **Evidence.** §8's route list contains `GET` and `PUT` on `…/projects/:projectId/repository-binding` and no `DELETE`; §9.3 permits only `active -> retired` on bindings, with no command that triggers it independently of repository retirement.
- **Violated.** Not a contract invariant — an operability defect that will surface immediately in the CT-04E AQ-01 dogfood (DOG-AQ-001).
- **Required plan change.** Add an explicit Owner/Editor binding-retire command (`DELETE …/repository-binding` or `POST …/repository-binding/retire`), with its own audit action and the `project-repository-binding-retired` event from F-06, or record in §14 and `docs/operations.md` that a mis-binding is uncorrectable in CT-04A and requires manual database intervention. The second is a legitimate choice for a slice this size; the plan must not leave it unstated. Also state whether one repository may be actively bound to several projects in a workspace — §9.3's partial unique index constrains only the project side, and CT-04C's "one active operation per repository" rule will care.
- **Suggested adversarial case.** Bind repository R to projects P1 and P2; retire the binding for P1; assert P2's binding, R's status, and R's identity reservation are all untouched.

### F-15 — Medium — `active` is displayed with no evidence of when it was last true

- **Claim.** §10 states "List/read operations use stored evidence and do not inspect host paths," and §9.1's column list has no last-verified timestamp. A repository deleted while the daemon was down reads as `active` indefinitely, with nothing in the response distinguishing "verified seconds ago" from "verified at registration three weeks ago."
- **Evidence.** §9.1 columns: `registered_at`, `status_changed_at` — both record when a *transition* happened, neither records when the current status was last *confirmed*. §11 explicitly says an unchanged inspection appends no event and sends no notifier, so successful confirmations leave no trace at all. CT-04A introduces no startup reconciliation (correctly — it has no durable side-effect intent), so restart does not refresh status either.
- **Violated.** CT04-I05, CT04-I24; parent §2 governing statement on honest evidence.
- **Required plan change.** Add `last_verified_at` (and `last_verified_by_user_id`) as the one deliberately mutable non-transition field, updated by every successful inspection including unchanged ones, and carry it in `RepositoryResponse`. Say explicitly that updating it appends no workspace event — that is the right call and it needs to be a stated rule so an implementer does not "fix" the missing event later. State in §11 that CT-04A performs no startup reconciliation and why, so CT-04C's implementer does not assume one exists to extend.
- **Suggested adversarial case.** Register, stop the daemon, delete the path, restart, and read the repository: the response must expose a stale-verification timestamp rather than an unqualified `active`.

### F-16 — Medium — No audit policy for denied or failed registration

- **Claim.** §9.4's audit catalog registers seven success-shaped actions and no denial or failure action. §11 says only that failure "creates no row, success audit, success event, or notification," leaving whether a *failure* audit is written undefined for the first command in the system that touches the host.
- **Evidence.** CT-03's catalog (`0002-ct03-planning.sql:22–35`) registers `admin.bootstrap.denied`, `auth.login.failed`, `workspace.access.denied`, `plan.import.failed`, `plan.import.duplicate` — the established posture is that denials and failures are auditable. `audit_events.outcome` already has a `'denied' | 'failed'` domain (`0001…:489`). The contract family expects an explicit answer: JRN-CR-002 says "bounded failure audit according to accepted policy."
- **Violated.** CT04-I03; A-ROLE-001; source assessment §9 (host-path authorization is the new risk surface).
- **Required plan change.** Register `repository.register.denied` and `repository.register.failed` (or state a single `repository.register` action with `outcome IN ('succeeded','denied','failed')` — the column already supports it, and that may be the smaller change), and state the rule: an Owner-role denial and every classified host/Git failure writes a bounded audit row whose metadata carries the failure classification and never the requested path's contents, repository config values, or subprocess stderr. Bound the metadata size.
- **Suggested adversarial case.** Editor attempts registration: assert 403, zero inspector calls, one `denied` audit row, no workspace event, no notifier. Owner registers a bare repository: assert one `failed` audit row carrying the classification and no path-derived payload beyond the requested path itself.

### F-17 — Medium — Scope sits exactly on the protocol's split trigger, and F-02 shows the real tree is larger

- **Claim.** §13 predicts "60 changed/new files and approximately 4,500–6,000 lines." Process protocol §4 makes "more than roughly 60 changed files, more than one new authority boundary, or both a major schema and substantial browser surface" a mandatory split proposal. The plan lands on the threshold and F-02 adds four more files to it.
- **Evidence.** §13's tree; process protocol §4 and §7 ("The threshold is a review trigger, not an invitation to game file counts"); parent contract §5 ("If Phase A predicts that a slice must change more than three architectural layers at once … propose a further split"). CT-04A changes five packages plus docs. The CT-03 precedent in the source assessment §6 is a 132-file generation whose green tests concealed four recurring defect classes.
- **Violated.** Process protocol §4; parent §5.
- **Required plan change.** Propose the split explicitly and let the operator decide. The natural seam is clean and matches the plan's own structure: **CT-04A1** — `packages/git` (runner, path policy, inspector, fixtures), `apps/server/src/config.ts`, the scope-checker narrowing, ADR-016, and the REG-PATH/REG-GIT case groups, with no schema, no routes, and no event kinds; **CT-04A2** — domain and contracts records, migration 0003, storage repositories, the service and routes, the projection/activity extension from F-02, ADR-017, and the REG-ID/OWN-REP/JRN-REP/A-* groups. A1 has no database and no journal; A2 has no new process authority. Every CT-04A protected case maps cleanly to exactly one of the two. If the operator declines the split, the accepted plan must at least raise its declared budget to the corrected file count rather than starting over-budget.
- **Suggested adversarial case.** Not applicable — this is a decomposition decision, not a testable invariant.

### F-18 — Low — Git and repository roots become hard startup dependencies for a planning-only daemon

- **Claim.** §6 makes `CRAFTINGTABLE_REPOSITORY_ROOTS` "a required, nonempty" setting and §5.1 fails startup when no Git executable resolves. A daemon used only for CT-03 planning can no longer start on a machine without Git or without a configured source root.
- **Evidence.** §5.1, §6. §13 does list `apps/server/src/test-support.ts`, `config.test.ts`, and `e2e-entry.ts`, so the test fleet is accounted for — the gap is the operator-facing regression, not the suite.
- **Violated.** CT-04A exit gate "All CT-01 through CT-03 tests still pass" (satisfied) — but not the spirit of not regressing accepted behaviour.
- **Required plan change.** State the decision deliberately. Either make both hard dependencies and record it in `docs/operations.md` as a CT-04A upgrade note with the exact new required variables, or make repository roots optional-but-empty (registration then fails with "no source roots configured") and defer Git resolution to first use. The first is simpler and defensible; it just must not arrive as a surprise.
- **Suggested adversarial case.** `config.test.ts` cases for missing roots, empty roots, a relative root, a root that is a symlink, two roots where one is an ancestor of the other, and a root overlapping `dataDir`, `artifactRoot`, or `managedWorktreeRoot` in both directions.

### F-19 — Low — Four state-machine edges and the direct-storage matrix are asserted but not mapped to tests

- **Claim.** §7, §9.2, and §9.3 state rules for which §14 names no permanent proof: `unavailable -> active` recovery (and the case where the path reappears with *different* identity, which must go to `identity-mismatch`, not `active`); binding rejected against an `unavailable` or `identity-mismatch` repository at both the service and the §9.3 insert-trigger level; `repository_policies` immutability; and direct-SQL attempts to mutate identity columns, delete a repository row, or reverse a transition.
- **Evidence.** §14's 47 rows cover every ID in `CT-04-acceptance-matrix.yaml` for CT-04A — the ID-level mapping is complete, which is genuinely good. These four are rules the plan invents beyond the matrices and then does not carry into it.
- **Violated.** Process protocol §5 ("tests that prove examples but not invariants") and §9.
- **Required plan change.** Add the rows. §15.1's relationship table is the right instrument and already exists — extend it rather than writing prose.
- **Suggested adversarial case.** Delete a registered repository's directory, inspect (→ `unavailable`), recreate a *different* repository at the same path, inspect again: the result must be `identity-mismatch`, never `active`. This single case exercises the edge the plan is most likely to get wrong.

### F-20 — Low — `display_name` has no bounds, charset, default, or mutability rule

- **Claim.** §8 makes `displayName` optional; §9.1's constraint list covers paths, stat strings, digests, object format, policy version, status coupling, and version — not `display_name`. Nothing says what an omitted name defaults to, whether it may contain control characters or newlines, or whether it can ever be changed.
- **Evidence.** §9.1; §8's `RegisterRepositoryRequest`. REG-PATH-012 deliberately admits top-level paths containing newlines and metacharacters, so a basename-derived default inherits them, and F-02 establishes that the value reaches `ActivityPanel.tsx` (React escapes markup, so this is a legibility and bounding concern, not XSS).
- **Violated.** UI-RENDER-002's class, arriving one slice early via the activity feed.
- **Required plan change.** Bound it (1–120 characters, matching `projects.name`), reject control characters including newline and tab, state the default (basename, with the same validation applied and an explicit rejection if it fails), and state that it is immutable in CT-04A since no rename route exists.
- **Suggested adversarial case.** Register a repository whose top-level basename contains a newline with `displayName` omitted; the request must be rejected with an actionable message rather than storing an unrenderable name that can never be corrected.

### F-21 — Low — Version-string parsing and the credential-prompt proof

- **Claim.** Two smaller items in §5.1 and §14. First, "Nonstandard or unparseable version output fails startup" will reject legitimate vendor builds — `git version 2.39.3 (Apple Git-146)`, `git version 2.45.0.windows.1`. Second, §14 proves REG-GIT-004 with a fake executable, which is the only option available: none of CT-04A's three read-only commands can cause real Git to prompt.
- **Evidence.** §5.1, §14 REG-GIT-004 row. Local Git reports the plain form `git version 2.54.0`, so a strict parser would pass here and fail elsewhere.
- **Required plan change.** Specify the parser as "leading `git version <major>.<minor>[.<patch>]`, trailing content ignored." Record the REG-GIT-004 proxy as an explicit stated limitation with its reason, so a code reviewer does not read it as an untested case and a CT-04C reviewer knows the real prompt surface arrives with `worktree add`.
- **Suggested adversarial case.** Parser unit tests over the three vendor forms plus empty output, a non-`git` banner, and a `1.x` version.

### F-22 — Info — Two presentation defects in the plan itself

- §4's dependency diagram lists `server` twice with arrows that do not describe the stated direction; redraw it, since it is the artifact a later slice will cite.
- §2 reconciles the baseline but does not report a divergence it should have caught: `CT-04-source-assessment.md` §11 says "The public repository README still describes CT-02 as the current phase," while `README.md:9` at the baseline says **CT-03**. Process protocol §4 requires Phase A to report divergence from the assessment. A-DOC-001's wording survives either way, but the accepted plan should record the correction.

## Coverage gaps

**Protected-ID mapping is complete.** Every CT-04A case in `CT-04-acceptance-matrix.yaml` and `protected/CT-04-protected-acceptance-spec.yaml` — REG-PATH-001..012, REG-ID-001..008, REG-GIT-001..008, OWN-REP-001..006, JRN-REP-001..005, A-API-001, A-MIG-001, A-NOTIFY-001, A-ROLE-001, A-DOC-001, P-PROCESS-001..004 — appears in §14 with a named permanent proof. That is a real strength and I want it recorded as such. The gaps below are all rules the plan *invents* and then does not carry into the matrix, plus one weak mapping.

- **Retirement** — the entire command (F-05).
- **Cross-workspace registration through the service** — REG-ID-003 is proved only by direct SQL (F-10).
- **Binding-retirement journal completeness** — no event, therefore no ordering test (F-06).
- **State-machine edges** — `unavailable -> active`, reappearance-with-different-identity, bind-against-non-active at both service and trigger level (F-19).
- **Direct-storage attempts** — the plan asserts identity/workspace/actor/time immutability and no-delete triggers in §9.1–9.3; §14 maps only OWN-REP-004 and REG-ID-003 to schema tests. The full direct-SQL negative matrix (mutate identity, mutate registration actor, delete row, reverse transition, un-retire, insert policy row for a foreign repository, insert binding whose retirement columns are partially NULL) needs enumerating (F-19, F-12).
- **Revoked-membership dimension** — absent from §15.1 for both actor relationships (F-13).
- **Concurrency** — no case for two simultaneous registrations of the same path, or two simultaneous inspections racing the same status transition. The single-connection SQLite write lock probably makes both benign; the plan should say so rather than leave it unaddressed, since CT-04C inherits the reasoning.
- **CT-03 regression under CT-04A events** — no case proving the existing dashboard projection and SSE stream survive a workspace containing repository events (F-02).
- **`repository_policies` immutability** — asserted in §9.2, unmapped (F-11).
- **Crash windows** — CT-04A genuinely has few: it commits no durable side-effect intent, so the only windows are (i) between the two admissions and the transaction, (ii) between commit and notifier, (iii) daemon death with a read-only Git child outstanding. §6 covers (i), JRN-REP-004 covers (ii), (iii) is harmless. The plan should *say* this — an explicit "CT-04A introduces no durable intent and therefore no reconciliation" statement is what stops CT-04C from assuming a reconciliation hook already exists (F-15).
- **Browser temporal identity (CT04-I22)** — correctly out of scope; CT-04A adds no fetch. But F-02 means it touches the projection, so the accepted plan should state that no new async request identity surface is introduced and that UI-ID-*/UI-LATE-* remain CT-04E.

## Scope assessment

One authority boundary (the local Git process), one migration, no repository-side writes, no browser views. The slice is coherent and the three-command surface is genuinely minimal — `version`, `rev-parse`, `config --get-regexp` and nothing else, with `FixedGitCommand` as a closed union rather than an `{command, argv, env}` carrier. That is the right shape and it should survive review unchanged.

**CT-05+ leakage: none found.** No change-request, branch, worktree, diff, artifact, agent, check, review, or merge behaviour. The `later-mutation-blocked` policy value is forward-referential but is explicitly permitted by parent §4 and §6.2, and it is the honest way to record a fact discovered at registration. Configuring `CRAFTINGTABLE_ARTIFACT_ROOT` and `CRAFTINGTABLE_MANAGED_WORKTREE_ROOT` in CT-04A is not leakage but a requirement — REG-PATH-009 and REG-PATH-010 are CT-04A protected cases that cannot be satisfied without both paths being known — and the plan is right to reserve the names without creating the directories. §18's forbidden-scope confirmation is accurate.

**Scope volume is the problem, not scope content.** 60 files is exactly the protocol's split trigger, the tree is understated by at least four files (F-02), and five packages plus documentation is more architectural layers than parent §5's "more than three" guidance contemplates. See F-17 for the proposed seam.

## Required operator decisions

1. **Split CT-04A?** (F-17) Recommendation: yes, along the A1/A2 seam in F-17. A1 has no database and no journal; A2 has no new process authority; the protected cases partition cleanly. If you decline, the accepted plan must restate its budget against the corrected tree.
2. **Identity evidence tiers and the exit from `identity-mismatch`.** (F-04) Recommendation: exclude `st_dev` from the terminal digest and add an Owner re-affirmation transition. Retirement must not be the only exit from a state a reboot can cause.
3. **Journal correlation for repositories: rebuild `workspace_events`, add a trigger, or accept payload-only correlation?** (F-07) Recommendation: rebuild now, following the 0002 pattern. CT-04B/C/D add four more resource classes behind the same decision, and `ALTER TABLE` cannot add the composite key later.
4. **Keep retirement in CT-04A?** (F-05) The slice contract says "retirement if included." If kept it needs a full case group; if dropped, CT-04A has no way to release a registration and that must be documented.
5. **Add a binding-retire (unbind) command, or document that a mis-binding is uncorrectable?** (F-14) Either is acceptable; silence is not, and DOG-AQ-001 will hit it.
6. **Registration failure/denial audit policy.** (F-16) Recommendation: reuse the existing `outcome` domain on a single `repository.register` action rather than adding two catalog entries.
7. **Are Git and `CRAFTINGTABLE_REPOSITORY_ROOTS` hard startup dependencies?** (F-18)
8. **Ownership policy for repositories not owned by the daemon UID.** (F-09) Recommendation: refuse with a classified 4xx and no `safe.directory` escape hatch in CT-04A.

## Re-review scope

If the operator accepts F-04, F-06, F-07, and F-17, the revised plan changes migration 0003's columns, the repository state machine, and possibly the slice boundary. Those warrant one short focused design re-review — limited to the identity state machine, the event catalog and correlation decision, and the corrected file tree — rather than a full second pass. F-01, F-02, and F-08 through F-22 are dispositions the implementer can record and fold into the accepted plan without further review.

---

**Review metadata** (process protocol §13)

```text
reviewer role        independent pre-implementation design reviewer
reviewer harness     Claude Code, Opus 5 (1M context), read-only session
plan reviewed        575df9d9caf427661696f747f6083dc8fa6adce81a3a7785db125b6b8791ddcb
source baseline      abc5f37815ad76430cae989224afde817d77a047
review checkout      06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4
protected spec       ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64 (verified unchanged)
findings             2 blocking, 4 high, 11 medium, 4 low, 1 info
verdict              FAIL — revise and re-review the identity state machine,
                     event correlation, and file tree; remaining findings are
                     implementer dispositions
```
