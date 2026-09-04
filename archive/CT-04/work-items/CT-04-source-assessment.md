# CT-04 source assessment

## 1. Assessment basis

This assessment is pinned to CraftingTable commit:

```text
abc5f37815ad76430cae989224afde817d77a047
```

The commit merges the accepted CT-03 plan-import and dashboard work into `main`. It contains the implementation, completion report, three remediation reports, and the corresponding independent reviews.

This is a static source assessment. The implementation agent must reconcile it with the local checkout during Phase A and report any divergence before planning code.

## 2. Current architectural state

The accepted architecture has clear dependency direction:

```text
domain        pure records and branded IDs
contracts     strict Zod HTTP/SSE contracts
planning      pure plan parsing and graph interpretation
storage       SQLite, migrations, SQL repositories
server        Fastify routes, services, composition
web           React projection over domain + contracts
```

`packages/agents`, `packages/git`, and `packages/testing` remain seams. Production composition imports neither the agent nor Git package.

The daemon owns authoritative state. The browser authenticates, loads a workspace snapshot with `asOfSequence`, replays workspace events after that cursor, and follows the durable live tail. New domain commands commit state, audit, and workspace events atomically, then call the in-memory notifier after commit.

## 3. The current Git seam is intentionally empty

`packages/git/src/index.ts` contains only the CT-01 demonstration interface:

```ts
export interface RepositorySnapshot {
  name: string;
  branch: string;
  headShaAbbrev: string;
  clean: boolean;
  simulated: true;
}

export interface GitService {
  describeRepository(): Promise<RepositorySnapshot>;
}
```

The file explicitly states that real Git execution, worktrees, branches, commits, and diffs were deferred to CT-04 and that no current code may shell out to Git.

This is a good seam, not a constraint to preserve literally. CT-04 should replace the fake snapshot with a typed process boundary and focused services. It must not grow one giant `GitService` whose methods become an unreviewable host-authority bucket.

## 4. CT-03's deliberate handoff

The current `WorkContractDraftDocument` marks these fields unresolved:

```text
registered-repository
exact-base-revision
path-scope
verification-policy
protected-acceptance-criteria
agent-backend
execution-environment
```

CT-04 should resolve repository and exact base identity. It should not falsely resolve future verification, agent, or environment fields.

The current work-item page correctly says that admission does not start work, create a worktree, review, or merge. CT-04 must preserve that distinction while adding a separate change-request lifecycle.

## 5. Current persistence and ownership posture

CT-03's schema is unusually defensive after remediation:

- composite foreign keys tie records to workspace, project, plan version, and work item;
- same-workspace/wrong-parent combinations are rejected;
- imported plan content is frozen by update/delete triggers;
- evidence must cite the version resolved by its import attempt;
- workspace-event correlations must identify one coherent project graph;
- work-item admission is a single terminal transition.

CT-04 must match this standard. A service-level query that happens to include `workspace_id` is not enough. Every new relationship needs a positive and negative ownership matrix at the database boundary.

## 6. CT-03 lessons that change the CT-04 process

CT-03's first implementation was a broad 132-file generation. Ordinary tests passed, but independent review found defects in four recurring classes:

1. **partial structural ownership** — some relationships were constrained while analogous relationships were not;
2. **partial immutability** — a parent was frozen while graph content beneath it remained mutable;
3. **weak runtime boundary schemas** — a supposedly structured draft used a permissive boundary;
4. **post-render or path-specific browser cleanup** — visible state was cleared after a wrong render or only for one navigation path.

The first two remediation cycles often fixed the demonstrated row or route without fully closing the invariant class. The final cycle succeeded after the analogous surfaces and temporal cases were enumerated explicitly.

CT-04 therefore requires:

- parent milestone decomposition;
- a separate design review before code;
- predeclared adversarial matrices;
- protected acceptance specifications;
- exact-head review evidence;
- invariant-closure remediation reports.

## 7. Current server seams

The accepted server is composed through dependency injection. Planning behavior is split among:

```text
routes/planning.ts
services/plan-import-service.ts
services/planning-query-service.ts
services/work-item-service.ts
storage repositories
```

CT-04 should follow the same direction:

```text
HTTP route
    → service with workspace authorization
    → typed Git boundary and storage repositories
    → state + audit + event transaction
    → post-commit notifier
```

Do not invoke Git directly from a route. Do not let the Git package write SQLite or publish workspace events.

## 8. Current browser seams

The browser currently has pure route parsing and planning API modules under:

```text
apps/web/src/lib/route.ts
apps/web/src/lib/planning-api.ts
apps/web/src/features/planning/
```

CT-03 remediation established an important rule: a response may update the browser only when its captured workspace and route/resource identity still match current navigation. CT-04 has more long-lived operations and must apply that rule to:

```text
repository list/detail requests
change-request detail
worktree operation polling or refresh
diff snapshot capture and retrieval
artifact retrieval
cleanup results
```

A route change via picker, direct URL, or browser history must invalidate stale async results before render.

## 9. Current security boundary

The accepted daemon is loopback-only and authenticated. It exposes no path, filesystem, Git, process, shell, SQL, or agent endpoint. CT-04 is the first work item to cross the host-process boundary and accept a host path during a privileged operation.

That raises several new risks:

- path traversal and symlink substitution;
- registration of CraftingTable's own data or worktree root;
- repository replacement after registration;
- command/argument injection;
- inherited Git environment overrides;
- hooks, filters, fsmonitor, external diff, textconv, pagers, and credential prompting;
- ambiguous worktree side effects after daemon death;
- unsafe cleanup or recursive deletion;
- output and diff-size exhaustion;
- cross-workspace physical repository reuse;
- browser rendering of hostile filenames and diff content.

The source repository is an operator-approved local trust domain, not arbitrary remote input. That assumption must be stated honestly; authentication alone does not sandbox hostile Git repositories.

## 10. Current operations and storage

The current operations guide identifies SQLite schema 2 and explicitly defers a general artifact store. CT-04D is the first justified need for one because diff patches and future logs should not be forced into SQLite BLOBs.

The new artifact seam should remain narrow:

```text
content-addressed immutable bytes
bounded writes and reads
server-generated paths only
atomic publish before metadata reference
hash verification on read
no user filesystem browsing
no deletion/GC in CT-04
```

Plan source artifacts may remain in SQLite; CT-04 does not need to migrate them.

## 11. Documentation drift observed at the baseline

The public repository README still describes CT-02 as the current phase even though CT-03 is merged and accepted. This is not a runtime defect, but it is exactly the kind of status drift CraftingTable should avoid. CT-04A should update the active-phase references for the current slice, and CT-04E should leave the README and operating documentation describing the completed parent milestone.

## 12. Source-to-target disposition

| Current source | CT-04 disposition |
|---|---|
| `packages/git/src/index.ts` | Replace fake seam with focused typed runner, inspector, worktree, status, and diff boundaries |
| `packages/domain/src/ids.ts` | Add repository, binding, change-request, operation, worktree, generation, artifact, and diff IDs |
| `packages/domain/src/work-contract.ts` | Add a projection that can reference repository/base facts without pretending the draft is executable |
| `packages/domain/src/workspace-events.ts` | Register semantic repository/change-request/worktree/diff events |
| `packages/domain/src/audit.ts` | Register matching command audit kinds |
| `packages/contracts` | Add strict request/response schemas; never accept raw argv or worktree paths |
| `packages/storage` | Add sequential migrations, repositories, atomic commands, and structural ownership constraints |
| `apps/server/src/config.ts` | Add canonical allowed repository roots, worktree root, Git executable, and bounded operation settings |
| `apps/server/src/composition.ts` | Compose Git runner, artifact store, services, and startup reconciliation |
| `apps/server/src/routes` | Add authenticated repository/change-request/diff routes; no generic Git route |
| `apps/server/src/services` | Own authorization, durable intent, post-commit notifications, and reconciliation coordination |
| `apps/web/src/lib/route.ts` | Add workspace-scoped repository/change-request routes with identity-safe transitions |
| `apps/web/src/lib/*-api.ts` | Add runtime-validated repository/change-request/diff APIs |
| `apps/web/src/features` | Add focused repository/change-request/diff views, not a full IDE |
| `docs/architecture.md` | Document host process and artifact boundaries |
| `docs/security.md` | Document path, Git, repository trust, diff, and cleanup controls |
| `docs/operations.md` | Document source roots, worktree root, artifacts, recovery, and cleanup |

## 13. Areas that must remain absent

A source review after each slice should confirm that the repository still lacks:

```text
agent SDK imports in production composition
arbitrary shell/process routes
clone/fetch/pull/push
commit/merge/rebase/reset/stash
review findings and merge readiness
LAN binding or TLS deployment
ActionQueue, WorldInterface, or Exoskeleton runtime dependencies
```

## 14. Expected first dogfood path

At parent completion the operator should be able to:

```text
register the local ActionQueue repository as an Owner
bind it to the imported AQ-CONT-1 project
open AQ-01 and create a change request
choose an allowed local target ref
resolve and store an exact base commit
provision a controlled worktree and branch
make a small manual test edit in that worktree
capture a bounded immutable status/diff snapshot
review the file list and unified patch in the browser
revert the manual edit outside CraftingTable or leave it for CT-05
request cleanup and see dirty cleanup rejected
clean the worktree and safely remove only the managed worktree
```

CraftingTable does not yet start an agent or commit the change.
