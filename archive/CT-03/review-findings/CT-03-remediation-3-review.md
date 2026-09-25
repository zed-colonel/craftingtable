# CT-03 third-remediation re-review

## Review identity

- Repository: `zed-colonel/craftingtable`
- Accepted CT-02 source baseline: `c8e2396a65466bdde95bf740771af63b4fc2272e`
- CT-03 base: `2173d6c9ebc0edf28ab4adfb1775e8a098341e01`
- Initially reviewed head: `b226df5e1fe7931e69a3c9f8306dcf7b8900ba05`
- First-remediation head: `b8aff843124846f679c183c3bb924e1ef3717090`
- Second-remediation head: `498f0b7d462b2780dbfce73d618116d6c01e1b58`
- Reviewed third-remediation head: `195dd8d27b226ff6a67fdf7211579fbc40792848`
- Third-remediation merge-base with the second-remediation head:
  `498f0b7d462b2780dbfce73d618116d6c01e1b58`
- Re-review disposition: **Accepted — no findings**

The third remediation was reviewed first as the complete working-tree patch
atop the second-remediation head. After all focused verification and the full
gate passed, that exact patch was committed to establish the immutable reviewed
head above. No source changed between verification and that commit.

## Deterministic verification

| Verification | Result |
| --- | --- |
| `pnpm exec node --version` | `v24.18.0` |
| Focused App and storage suites | 2 files, 61 tests passed |
| `pnpm check` | Passed: format 192 files, lint 193 files, typecheck/build passed, Vitest 54 files and 407 tests passed, Playwright 4 tests passed, forbidden-scope check passed |
| AQ fixture checksum manifest | Both fixture files verified |
| AQ fixture behavior | Exactly 14 items, 24 required edges, and only initial planning-ready root `AQ-01` |
| Remediation diff check | `git diff --check` passed |
| Tracked-source integrity | No NUL bytes; planning package purity and forbidden-scope checks passed |

## Focused remediation verification

### CT03-R2R1 — failed-import evidence parentage

**Resolved.** Artifacts and diagnostics now retain the always-enforced
`(workspace_id, import_attempt_id)` parent key as well as the three-column
attempt/version coherence key. Versionless evidence for a missing or
cross-workspace attempt is rejected. Versionless evidence on a succeeded
attempt is rejected by the insert trigger. Valid versionless evidence on the
failed attempt that owns it remains accepted.

The focused probe observed:

```text
valid failed-attempt artifact                         ALLOWED
NULL-version artifact with missing attempt            REJECTED
NULL-version artifact borrowing foreign attempt       REJECTED
NULL-version artifact on succeeded attempt            REJECTED
NULL-version diagnostic with missing attempt          REJECTED
NULL-version diagnostic on succeeded attempt          REJECTED
non-NULL artifact naming a different version          REJECTED
```

### CT03-R2R2 — event correlation

**Resolved.** A work-item correlation now requires a project, retains the
independent workspace/work-item parent key, and must match the same
workspace/project/item tuple. Correct work-item events and workspace-only events
remain legal.

The focused probe observed:

```text
work item with no project correlation                 REJECTED
project paired with sibling project's work item       REJECTED
matching project/work-item correlation                ALLOWED
workspace-only event                                  ALLOWED
```

### CT03-R2R3 — in-flight browser results

**Resolved.** Artifact, import, and admission requests capture the workspace
that issued them and check the render-current workspace before every state write
or navigation. Workspace switching resets the corresponding busy states.
App-level deferred-response tests now settle the old callbacks after the new
workspace is fully loaded and prove that no old artifact, outcome, error, busy
state, or navigation appears.

### CT03-R2R4 — route-driven workspace identity

**Resolved.** The render-current workspace is derived synchronously from an
authorized route identity, and the projection guard and picker use that value.
The deep-link test samples committed DOM state across microtask turns rather
than observing only settled state; no prior-workspace content is committed under
the new route.

## Findings

No blocking, high, medium, low, or informational findings remain at
`195dd8d27b226ff6a67fdf7211579fbc40792848`.

## Area verdicts

### AQ fixture and dependency semantics

**Pass.** The exact accepted fixture produces 14 items and 24 required edges.
It is acyclic, recommended edges remain nonblocking, and `AQ-01` is the only
initial planning-ready root.

### Migration preservation and persistence

**Pass.** Migration `0002` preserves CT-02 audit/event rows, identities,
sequences, indexes, constraints, and append-only trigger behavior while allowing
future migration-owned vocabulary registration without another history rebuild.

Planning ownership is structurally coherent across workspace, project, bundle,
version, item, dependency, draft, attempt, artifact, diagnostic, and event
relationships. Plan content and historical work graphs are immutable; a work
item permits only one attributable, version-incrementing
proposed-to-admitted transition. Failed, duplicate, and successful imports retain
honest atomic evidence without partial accepted state.

Because CT-03 remained unmerged while migration `0002` was corrected in place,
the documented operator requirement remains: a local database that ran an
earlier CT-03 migration 0002 must be reset. Migration `0001` is unchanged, so a
CT-02-era database remains valid.

### Security and isolation

**Pass.** Multipart bounds apply before parsing; filenames are logical
non-path identities; YAML parsing is bounded and non-executable; source rendering
is non-executable; audit/diagnostic metadata remains bounded; and session,
CSRF/origin, role, and workspace-scoped read protections retain passing
evidence.

Persistent relationships and browser projections are workspace coherent.
Workspace selection, deep links, refreshes, and deferred planning responses do
not project old-workspace data under the new workspace identity.

### Admission and draft contracts

**Pass.** Admission remains explicit, attributable, atomic, idempotent, and
available through deliberate action even while dependency blockers remain
visible. The shared draft contract is strict, runtime-validated, visibly
incomplete, and non-executable. No approval, execution, worktree, agent,
verification, review, or merge authority was added.

### Notification, snapshots, and recovery

**Pass.** Every CT-03 daemon event producer notifies only after commit. Fast-path
tests prove delivery without depending on the fallback poll; dropped-notifier
recovery remains covered. Events stay low-volume summaries, snapshots retain
consistent counts and `asOfSequence`, and the browser refetches authoritative
state. Refresh, outage, reconnect, and restart behavior remain green.

### Architecture and scope

**Pass.** `@craftingtable/planning` remains pure. Domain, contracts, storage,
server, and browser boundaries remain intact. No CT-04+ behavior, Exo Stack
dependency, broad frontend rewrite, plugin framework, or generalized workflow
system entered the runtime.

### Acceptance evidence

**Pass.** Every CT-03 acceptance ID has credible source and passing test evidence
at the reviewed head. The previously contradicted persistence and browser
isolation cases now have focused negative and positive coverage in addition to
the full deterministic gate.

### CT-04 readiness

**Pass.** CT-04 can build on this result without bypassing or compensating for
CT-03. The durable ownership, immutable-history, admission-only mutation,
strict-draft, event, recovery, and browser workspace-identity boundaries are now
credible foundations.

## Merge decision

Approved for commit and merge into `main`.
