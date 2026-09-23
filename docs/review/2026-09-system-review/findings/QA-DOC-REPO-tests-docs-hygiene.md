# QA / DOC / REPO review: test suite, tooling, build, documentation, repository hygiene

Reviewer scope: package.json scripts, vitest/playwright/biome/tsconfig, `e2e/`, `scripts/`,
every `*.test.ts(x)`, test-support modules, README and `docs/` (architecture, ADRs,
ui-principles, operations, security, roadmaps, plans), `docs/ui-walkthrough`, `.git`,
legacy directories. Reviewed at HEAD `bf08c0b` (2026-09-22). Read-only; the only commands
run were `git` queries, `biome lint`/`format` (read-only), one full `pnpm vitest run`
(JSON reporter written to the scratchpad) and small `node -e` probes of the scope checker.
`pnpm typecheck`/`build` were deliberately **not** run: `tsc -b` rewrites `packages/*/dist`,
which the live daemon imports (see REPO-04). E2E and the walkthrough were not run.

## Summary

- **The repository is 99% screenshots.** `docs/ui-walkthrough/` holds 4,986 PNGs (57 captures,
  1,499 MiB of the 1,508 MiB HEAD tree); history contains 3,185 unique PNG blobs = 1,080 MiB
  on disk vs 10 MiB for *everything else combined*. Growth averages about 155 MiB/day
  (57 captures in 7 days, about 40 MB each). Captures are not deterministic (fresh UUIDs and
  timestamps each run), so consecutive captures of the same code share only about 30% of blobs.
- **None of it has been pushed.** `origin/main` is `d6d5dc6` (2026-09-16); all 42 local commits,
  including every walkthrough commit (first: `ccee249`), are local only. This is the cheapest
  moment ever to remove the PNGs from history. It is also a backup risk: six days of work
  exist only on one disk.
- **Unit suite: 1,265 tests, all passing, 5 min 46 s wall-clock, and one file accounts for all
  of it.** `apps/server/src/server-execution.test.ts` (14,084 lines, 550 KB, about 140k tokens,
  274 tests) runs 344 s serially. Every other file finishes in under 10 s. Splitting this file
  alone would cut `pnpm test` to under a minute on this 16-core host.
- The giant file is an **accretion log**: 20 `describe`s plus 100 top-level `it`s interleaved,
  58 helper definitions scattered through it, one `describe` spanning 4,900 lines. 31 of the
  last 42 commits touched it. It polls wall-clock state (`waitFor` ×234, fixed sleeps of 1.2 s)
  because the controller has no deterministic stepping seam.
- **The authorization tests test names, not behaviour.** `route-inventory.test.ts` "exposes no
  route that could … approve" passes because no URL contains the substring `approve`. Routes
  such as `…/authorize-native`, `…/runtime/decide` and `…/amendments/decision` do approve
  things. There is no table-driven sweep of the 121 routes for 401/403/404, even though
  auth is enforced per handler (108 call sites) and per service method (96 `requireRole`
  calls).
- **The `check:scope` tooling is a pattern allowlist, which is the kind of check the operator
  rejected (A1-F-07).** Any production file whose path contains `test-support` or `/fixtures/`
  is exempt. Bare `fs`/`os`/`dns` pass the "pure planning" check. Dynamic `import()` and
  `process.getBuiltinModule` pass everything. ADR-008 still describes the stricter checker that
  the pivot commit `3f3441c` removed.
- **The e2e gate takes 35 unasserted screenshots.** No `toHaveScreenshot` exists anywhere. The
  one known flake (`package-imports.spec.ts:531`) is one of these screenshots, taken while
  `RoadmapsPage` re-polls every 3 s (`RoadmapsPage.tsx:167`). Login and Git helpers are copied
  into 8 specs.
- Tests hard-code host tools: `/usr/bin/git`, `~/.cargo/bin/cargo`, `/usr/bin/act`. The unit
  suite really runs `cargo`. `pnpm check` is only reproducible on this workstation. Git
  fixtures create temporary repositories inside the repo root (`process.cwd()`); a leaked one
  from 2026-09-09 is still there.
- Biome reports **666 warnings** (645 `noNonNullAssertion`, about 180 of them in production
  services), and the gate ignores them. Every package still emits its tests and test-support
  into `dist` (110 `*.test.js`); only `packages/git` adopted the structural `test/` boundary.
- **The README is a changelog, not a guide.** Lines 12–396 of its 600 lines are 34
  dense "What works today" feature paragraphs appended commit by commit (72 commits touched it).
  Two sections sit after "Non-goals". It says schema 22; there are 26 migrations. The
  configuration table omits about 14 of the variables the daemon reads.
- **ADR sprawl.** 65 ADRs, 28k words, two file-naming schemes, five status-line formats. The index
  lists only 001–032 and 051–053. Nine ADRs refine "finalization" in a chain. The status
  metadata is wrong in several places (ADR-031 still "accepted" although ADR-034 supersedes
  it; ADR-028 still "proposed" but implemented). The narrative docs (README, ui-principles,
  security, operations) repeat per-feature text instead of principles.
- Spot-check of 14 doc claims: **7 stale or false**, 7 accurate (details in DOC-03).
- Legacy directories: `review-findings/`, `implementation-reports/` and `work-items/` (CT-01..03)
  sit at the root while their CT-04 siblings were archived. `docs/plans/`,
  `docs/finalization-roadmap.md` and `docs/cross-project-roadmap.md` are completed planning
  documents that AGENTS.md says the repo does not want. There are 7 merged CT-era local
  branches (one named `ct=04a2b1-…`). Untracked leftovers: `packages/testing/` (dist only)
  and `.ct04a-git-test-iJlU8M/`.

## Map

### Tooling and gates (root `package.json`)
- `pnpm check` = `format:check → lint → typecheck → build → test → test:e2e → check:scope`
  (fail-fast, local only, no CI). Measured components:
  - `biome format` 0.2 s, `biome lint` 0.4 s (545 files; 666 warnings, 11 infos, no errors).
  - `vitest run`: **346 s wall**, 1,265 tests / 145 files / 298 suites, 0 failures (measured
    2026-09-22 20:22 while other review agents were running, load average about 3 on 16 cores).
  - `typecheck` = `tsc -b` (TypeScript 7 native) + web + `packages/git/tsconfig.test.json`. Not
    run (writes `dist`).
  - `test:e2e` = `tsc -b && playwright test`. 11 specs (walkthrough excluded), 2 projects
    (`chromium` 1440×900, `mobile-chromium` iPhone 13 for 6 specs), `workers: 2`, a single
    shared e2e daemon on port 4610 plus Vite on 5183. Duration not measured; the last run's
    artifacts span 19:19–19:21.
  - `check:scope` = `scripts/check-forbidden-scope.mjs`, a regex import scanner plus a
    process-authority map of 6 files.
- `vitest.config.ts`: two projects (`node`, `web`/jsdom). Aliases packages to `src`.
- `playwright.config.ts`: `walkthrough` project only when `CRAFTINGTABLE_WALKTHROUGH=1`.
  Fake agents `e2e/fake-claude.mjs` (324 lines) and `e2e/fake-codex.mjs` (159 lines).
- `pnpm ui:walkthrough` → `e2e/walkthrough.spec.ts` (848 lines) writes
  `docs/ui-walkthrough/<UTC-date>-<label>/{desktop,phone}/*.png` + `README.md`.

### Test distribution (tracked `*.test.ts(x)`, lines)
| Package | src lines | test lines | files | notes |
|---|---|---|---|---|
| apps/server | 32,468 | 22,879 | 44 | 14,084 in `server-execution.test.ts` |
| apps/web | 23,422 | 6,362 | 34 | 1,283 in `execution-views.test.tsx`; `RoadmapsPage.tsx` (1,091 lines) has no unit test |
| packages/storage | 6,926 | 6,582 | 17 | migrations 0002–0004 (CT-04A) heavily tested |
| packages/git | 4,402 | 2,816 | 6 | in `packages/git/test/` (structural boundary) |
| packages/agents | 3,243 | 1,784 | 11 | `process.ts` has no direct test; covered via backend tests with real child processes |
| packages/contracts | 4,818 | 1,623 | 15 | |
| packages/planning | 4,314 | 1,353 | 9 | |
| packages/domain | 4,082 | 591 | 9 | |
| e2e | – | about 3,800 | 11 specs | no shared helper module |

### Coverage against the AGENTS.md "expensive seams"
- **Process supervision:** real child processes in `claude-code/backend.test.ts` (SIGTERM-ignoring
  child, background work, process group), `codex/backend.test.ts`, `restart.test.ts`. Adequate.
- **Event persistence and replay:** `server-events.test.ts`, `workspace-event-stream-service.test.ts`,
  `contracts/workspace-event.test.ts`, storage transaction tests. Adequate.
- **Git mutation:** `packages/git/test/operations.test.ts` (830 lines) plus merge flows in
  `server-execution.test.ts`. Adequate but slow.
- **Authorization:** `server-auth.test.ts` (session, CSRF, cookies) plus scattered per-feature 401/403
  assertions (11 `viewer` references). **No systematic coverage** (QA-03).
- **Orchestration (controller):** almost entirely in `server-execution.test.ts` through HTTP inject
  plus the `ScriptedBackend` fake, with wall-clock polling.

### Documentation
- README 600 lines / 6,322 words. `docs/architecture.md` 4,386 words, `security.md` 4,304,
  `operations.md` 3,230, `ui-principles.md` 3,068, two "roadmap" status docs (1,562 words),
  `docs/plans/2026-09-09-codex-backend.md` (historical). 65 ADRs, 3,596 lines, about 27,900 words.
- Legacy: `init/` (6 files, background per AGENTS.md), `archive/CT-04` (105 files, 2.1 MB),
  `review-findings/` (8), `implementation-reports/` (8), `work-items/` (13). Nothing in code
  references them.

### Repository storage
- `.git` 1.1 GB: 3,443 loose objects = 942 MiB (never packed: under `gc.auto`'s 6,700 threshold),
  2 packs = 157 MiB. Walkthrough blobs: 1,080 MiB on disk; all other blobs: 10 MiB.
- Working tree `docs/` 1.5 GB. `git status` stays fast (6 ms, stat cache), so the cost is clone
  size, backup size, `gc`/repack time, agent file searches, and any future push.
- The live daemon runs straight from this checkout (`~/.config/systemd/user/craftingtable.service`:
  `WorkingDirectory=%h/src/craftingtable`, `ExecStart=pnpm start` → `tsx src/index.ts`).
  Workspace packages resolve to `packages/*/dist` (`"exports"` → `./dist/index.js`).

## Findings

### REPO-01: Walkthrough PNGs make up 99% of the repository and grow about 155 MiB/day
- Severity: high
- Category: performance
- Status: CONFIRMED
- Evidence:
  - `git ls-tree -r -l HEAD docs/ui-walkthrough` = 1,498.67 MiB of a 1,508.31 MiB tree. 5,043
    files (4,986 PNG + 57 README).
  - `git cat-file --batch-check` over all objects: 3,185 walkthrough blobs, 1,079.86 MiB on disk.
    All other blobs: 2,892, 10.0 MiB on disk.
  - 57 captures between 2026-09-16 and 2026-09-22. Recent captures are 39–41 MB each. Every
    feature commit since `828bf51` adds 142–306 files. Largest PNG 2.68 MB
    (`…/desktop/41-roadmap-recovery-delegation.png`). 46 PNGs exceed 2 MB.
  - Non-determinism: `2026-09-23-investigation-evidence-after` and
    `2026-09-23-delegation-preparation-before` capture adjacent commits but share only 32 of 110
    blobs. Their READMEs differ from line 12 because workspace and project UUIDs are embedded
    (`e2e/walkthrough.spec.ts` seeds a new workspace each run). Git therefore cannot deduplicate.
  - Directory dates use UTC (`walkthrough.spec.ts:41` `toISOString().slice(0,10)`), so
    captures taken on the evening of 2026-09-22 local time are labelled `2026-09-23-…`.
- Impact:
  - Clone and backup are about 1.1 GB and growing about 1 GB per week at the current rate.
  - Loose-object storage is uncompressed-in-effect (PNG): `gc`/repack will eventually take
    minutes, and the first `git push` will upload about 1.1 GB. GitHub warns above 1 GB and
    recommends staying under 5 GB.
  - Agents and tools that walk the tree (ripgrep, Biome with VCS, editor indexers) crawl
    1.5 GB of binary data unless each one excludes it by pattern.
  - AGENTS.md makes the capture mandatory "before and after any UI change". The cost is
    therefore structural, not incidental.
- Recommendation (structural, per the operator's stated preference):
  1. Move the capture root **outside the repository**. `e2e/walkthrough.spec.ts` should write
     to `CRAFTINGTABLE_WALKTHROUGH_DIR`, defaulting to
     `~/.local/share/craftingtable/ui-walkthrough/` or a sibling repository such as
     `~/src/craftingtable-ui-history` (its own git repo, or plain files plus the
     existing SQLite backup disk). Because the output lives outside the worktree, it cannot be
     committed by accident. This is a location boundary, not a `.gitignore`/LFS pattern.
     Coupled changes:
     - `walkthrough.spec.ts` output path;
     - `docs/ui-walkthrough/README.md`, which becomes a short pointer that explains how to
       find and compare captures;
     - AGENTS.md "Working method" exception paragraph;
     - memory note `craftingtable-ui-refactor-2026-09`.
  2. Optionally keep a small committed text index (`docs/ui-walkthrough.md`: label, commit,
     date, scene list) so the history of captures is still reviewable from the diff.
  3. Make captures deterministic: fixed seed IDs (or mask UUIDs in the README), a frozen
     clock for relative times, local-date labels. Consider `toHaveScreenshot`-style diffing
     against the previous capture so only changed scenes are stored.
  4. **Rewrite local history before the first push** (operator decision; CLAUDE.md forbids
     self-authorized history rewrites). All walkthrough commits are after `origin/main`
     (REPO-02), so a `git filter-repo --path docs/ui-walkthrough --invert-paths` over
     `origin/main..main` touches only unpublished commits. Move the captures to the new
     location first. After `git gc --prune=now` the repository shrinks to about 15 MB.
- Effort: S (move and document) + S (history rewrite, operator-run)
- Related: REPO-02, REPO-04, DOC-06
- Plan/roadmap format impact: none

### REPO-02: 42 commits (six days of work) exist only on the local disk
- Severity: high
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - `git rev-list --count origin/main..main` = 42. `origin/main` = `d6d5dc6` (2026-09-16).
  - `git merge-base --is-ancestor ccee249 origin/main` → not an ancestor.
  - `git rev-list --objects origin/main -- docs/ui-walkthrough` = 0 objects.
  - The memory note confirms pushing is deliberately Keith's call.
- Impact: every feature since the UI refactor (controller obligations, agent profiles,
  provider recovery, capacity consolidation…) has no off-machine copy. REPO-01 also makes the
  eventual push about 1.1 GB, which raises the pressure to postpone it.
- Recommendation: the operator decides; nothing should be pushed automatically. Sequence:
  REPO-01 step 4 (strip PNGs from the unpublished range) → push. Record in `docs/operations.md`
  that the SQLite backups do not cover the source repository. README line 440 already says
  this for supervised repositories.
- Effort: S
- Related: REPO-01
- Plan/roadmap format impact: none

### QA-01: `server-execution.test.ts` is the whole critical path of the unit suite and should be split by aggregate
- Severity: high
- Category: testing
- Status: CONFIRMED
- Evidence:
  - Vitest JSON (scratchpad `vitest-qa.json`): suite wall 346.4 s. This file: 343.8 s, 274 tests.
    Next slowest file: `server-package-imports.test.ts` at 9.9 s. Sum of all other files: about
    129 s, spread over 16 workers.
  - 11 tests take more than 5 s and 106 take more than 1 s. The slowest is 14.1 s ("recovers a
    verification defect, survives pause/restart…").
  - Size: 14,084 lines / 550,210 bytes (about 140k tokens, which an agent must load to extend
    it). The shared harness is lines 1–510 (`ScriptedBackend`, `GIT_ENV`, `fixtureRepository`,
    `waitFor`). 20 top-level `describe`s: `repository registration` :512, `agent runs` :654,
    `review-gated merge` :1015, `single work-item automation` :1841, `plan integration
    branches` :2843, `sequential roadmaps` :3411, `parallel roadmaps` :3868 (2,050 lines),
    `staged finalization` :7009, `execution slices and parent acceptance` :7799–12697
    (4,900 lines), `bounded model service recovery` :12697. 100 top-level `it`s sit
    interleaved outside any `describe`, and 58 helper functions/constants are defined after
    line 510 (e.g. `scopeTree`/`scopeReport` at :7720).
  - Change hotspot: 57 commits touch the file, 31 of them since 2026-09-15.
- Impact:
  - `pnpm check` cannot finish in under 6 minutes, which pushes agents to skip it or run
    subsets.
  - Every feature commit edits the same file, so parallel agent branches (the product's own
    parallel-roadmap use case) conflict on it.
  - An agent cannot hold the file in context.
- Recommendation:
  1. Extract lines 1–510 plus the recurring fixtures (`slicedFixture`, `scopeTree`,
     `scopeReport`, `reviewScope`, `startCycle`, `storedRoadmap`, `branchCommand`) into a
     structural test-support location, e.g. `apps/server/test/execution-harness.ts`
     (outside `src`; see QA-07).
  2. Split along the aggregates the controller owns, one file per `describe`:
     - `execution-repositories-worktrees.test.ts`
     - `agent-runs.test.ts` (runs, profiles, backend selection, handoffs)
     - `merge-gate.test.ts`
     - `work-cycles.test.ts` (single work-item automation, cycle supervision, background
       recovery, provider recovery)
     - `integration-branches.test.ts`
     - `roadmaps-sequential.test.ts`
     - `roadmaps-parallel.test.ts`
     - `finalization.test.ts` (finding decisions, agent selection, cleanup, staged)
     - `execution-scopes.test.ts` (the 4,900-line slice block, itself split into slices /
       verification / parent acceptance / scope recovery / shared decisions)
  3. Vitest parallelises files, so wall time falls to roughly the slowest aggregate (about
     60–90 s) without touching test logic.
  4. Add a lint rule or review convention: a test file over about 1,500 lines is split before
     it grows further.
- Effort: M (mechanical, but large; do it in one commit per extracted aggregate so reviewers
  can diff)
- Related: QA-02, QA-06, architecture findings on the monolithic controller
  (`work-cycle-service.ts` 4,029 lines, `roadmap-service.ts` 2,292 lines)
- Plan/roadmap format impact: none

### QA-02: Orchestration tests poll wall-clock time because the controller has no deterministic stepping seam
- Severity: medium
- Category: testing
- Status: CONFIRMED (mechanism). Flakiness under load is a HYPOTHESIS: all 274 passed in this run.
- Evidence:
  - `server-execution.test.ts:498` `waitFor(predicate, label, timeoutMs = 3000)` polls every
    10 ms and is called 234 times. Some calls extend the timeout to 8 s (:5511) and 15 s
    (:10318). Fixed sleeps: `setTimeout(resolve, 1200)` (:6192) and `100` (:12678).
  - `vi.useFakeTimers` appears once in the whole repository.
  - Production services schedule with raw timers (`agent-run-service.ts:1253,1298`;
    `storage-service.ts:643`) and no injectable scheduler or clock. There is no
    "quiescent"/"drain" API.
- Impact:
  - Test time is dominated by real waiting.
  - Fixed 3 s deadlines under heavy parallel load (for example agents running `pnpm check`
    while the daemon and other agents run) are a latent flake source.
  - "Nothing happened" assertions (e.g. :6192 "does not end the session") need arbitrary
    sleeps.
  - This is the test-side face of the operator's "controller transitioning" pain point: the
    transitions cannot be stepped or observed.
- Recommendation: when the controller is decomposed (see architecture findings), give the
  orchestrator an injected `Scheduler`/`Clock` and an `idle(): Promise<void>` that resolves
  when no transition is queued or running. Tests then call `await controller.idle()` instead of
  polling and can advance time explicitly. Keep a few real-time end-to-end tests.
- Effort: M (after the controller refactor), L if done independently
- Related: QA-01; controller/architecture findings; notifications during transitions
- Plan/roadmap format impact: none

### QA-03: The authorization surface has no systematic tests, and the "no approve route" test checks spelling
- Severity: high
- Category: testing (security-relevant)
- Status: CONFIRMED (gap). Whether any route actually lacks a check is a HYPOTHESIS, not
  observed: a rough per-file count found no obvious missing call.
- Evidence:
  - `apps/server/src/route-inventory.test.ts:139` `FORBIDDEN_ROUTE_FRAGMENTS = ['exec/',
    'command', 'shell', 'approve']`. Test :181 "exposes no route that could run a command or
    approve" only checks URL substrings. The allowlist it passes includes
    `POST …/runtime/authorize-native` (:43), `POST …/runtime/decide`,
    `POST …/amendments/decision`, `POST …/finalizations/:finalizationId/control` and
    `POST …/worktrees/:worktreeId/merge`.
  - Test :198 asserts that the route table contains no `url`/`path`/`zip`, which is also
    naming-based.
  - Enforcement is per handler: 108 `authenticate(`/`authorizeMutation(` calls across
    `routes/*.ts` for 121 routes. It is also per service method: 96 `requireRole(` calls
    (89 `['owner','editor']`, 6 `['owner']`).
  - There is no global `onRequest` guard (`grep addHook` finds only onClose/onReady).
  - Negative authorization tests are sparse: 11 `'viewer'` references across 4 test files, and
    ad hoc 401 checks in about 10 files.
- Impact: a new route that forgets `authenticate`/`authorizeMutation`, or a new service method
  that forgets `requireRole`, passes every test. The inventory test even makes it feel
  reviewed. Authorization is one of the four seams AGENTS.md says must be tested.
- Recommendation:
  1. Replace the substring test with a **table-driven authorization sweep** generated from the
     live route table (`app.printRoutes` is already parsed). For every non-public route:
     - no cookie → 401;
     - a mutating route without the CSRF header → 403;
     - a non-member → 404;
     - a `viewer` on any mutating route → 403 (the owner-only list is explicit).
     Keep `EXPECTED_ROUTES` as the review allowlist, but annotate each entry with its required
     role, so a new route cannot be added without stating its authority.
  2. Better, structurally: register routes through a helper that requires an `auth:
     'public' | 'session' | {role}` field and applies the guard itself, so the per-handler
     calls go away.
- Effort: S (sweep) / M (structural registration)
- Related: security reviewer findings
- Plan/roadmap format impact: none

### QA-04: `check:scope` exemptions are filename patterns, and several bypasses are open
- Severity: medium
- Category: security / testing
- Status: CONFIRMED (verified by calling the exported `sourceFindings` with synthetic inputs)
- Evidence:
  - `scripts/check-forbidden-scope.mjs:121–128` `isTestSource`: any path matching
    `\.test\.`, `/test/`, `test-support` **anywhere in the name**, or `/fixtures/` is treated as
    non-production and may import `node:child_process`.
  - `sourceFindings('apps/server/src/services/foo-test-support.ts', "import {spawn} from
    'node:child_process'")` → `[]`. The same holds for `apps/server/src/fixtures/runner.ts`.
  - The planning purity list (`:61–73`) matches only `node:`-prefixed builtins. `import fs
    from 'fs'`, `node:os` and `node:dns` in `packages/planning/src` → `[]`.
  - Computed `import('node:' + 'child_process')` and
    `process.getBuiltinModule('node:child_process')` → `[]`.
  - History: commit `3f3441c` (the pivot) replaced the earlier closed builtin allowlist
    (`A2A_ALLOWED_NODE_BUILTINS`) and the exact-path test allowlist with the current regexes.
    ADR-008 lines 41–46 still claim "Existing test-capability modules are exact-path
    allowlisted; a production filename containing `test-support` gains no authority", which
    is false.
- Impact: the mechanical guard for "process authority only in named adapters" can be escaped
  by naming, which is the failure mode the operator decided against on CT-04A1 (memory:
  *operator-prefers-structural-boundaries*). The docs overstate the guarantee.
- Recommendation:
  - Define production source structurally: everything under `*/src/` is production and every
    test lives under `*/test/` (QA-07). Then `isTestSource` becomes "path is under a `test/`
    root or `e2e/`", with no filename patterns.
  - Restore allowlists instead of denylists for builtins in `planning` and `domain`.
  - Flag computed `import()` and `getBuiltinModule` in production.
  - Update ADR-008 to match.
  - Longer term, enforce the dependency direction with TypeScript project references
    plus a small explicit-import check. The references already exist; for example,
    `planning` could get `"types": []` and no `@types/node`, so any Node import fails to
    typecheck. That is a structural boundary.
- Effort: S–M
- Related: QA-07, DOC-03
- Plan/roadmap format impact: none

### QA-05: E2E gate screenshots are unasserted, cause the known flake, and helpers are copied into 8 specs
- Severity: medium
- Category: testing
- Status: CONFIRMED
- Evidence:
  - 35 `screenshot(` calls across gate specs (mobile 8, finalization 8, package-imports 7,
    delegation 5, roadmaps 4, storage 2, notifications 1). No `toHaveScreenshot`/snapshot
    assertion exists in the repository.
  - Outputs are written to `test-results/` (56 MB currently).
  - Known flake (memory note, 2026-09-16): `e2e/package-imports.spec.ts:531`
    `amendments.screenshot(...)` fails with "Element is not attached to the DOM" because
    `RoadmapsPage.tsx:167` `setInterval(refresh, 3000)` remounts the panel.
  - Login is copied in 8 specs (`getByLabel('Username').fill('e2e-admin')`…).
  - A local `git()` helper is copied in 6 specs (`delegation.spec.ts:16`, `finalization.spec.ts:8`,
    `mobile.spec.ts:12`, `roadmaps.spec.ts:7`, `walkthrough.spec.ts:35`, …).
  - There is no `e2e/support` module. All specs share one daemon and one admin account
    (`workers: 2`, `fullyParallel: false`).
  - Long timeouts (15–30 s) are common in finalization/roadmaps/walkthrough.
- Impact:
  - The screenshots only produce flakes and runtime; they catch nothing.
  - Remounting on every poll is also a product smell. It matches the operator's "UI slowness
    as page elements react to automated transitions" and should be treated as a UI bug, not
    only a test flake.
  - Duplicated login and fixture code means a UI label change touches 8 files.
- Recommendation:
  - Delete the gate screenshots. The walkthrough is the capture mechanism.
  - Add `e2e/support/{session,git,fixtures}.ts` and a Playwright `storageState`/fixture for the
    signed-in admin.
  - Fix the roadmap page to reconcile rather than remount on poll. Better, drive it from the
    SSE event stream instead of a 3 s interval.
  - Give each spec its own workspace so specs are independent.
- Effort: S (remove screenshots, extract helpers) / M (poll to events)
- Related: UI and performance findings on polling and remounts; REPO-01
- Plan/roadmap format impact: none

### QA-06: The fixture derives expected scope evidence from the production resolver (tautological)
- Severity: medium
- Category: testing
- Status: CONFIRMED
- Evidence: `server-execution.test.ts:7728–7756` `scopeReport()` builds the reviewer's
  `scopeEvidence.requirements` and `caseIds` by calling production
  `resolveScope`/`scopeRequirements`/`scopeCases` (imported at :7–12). The same pattern
  appears at :8129, :8377, :8458, :10929, and at :11379 (`scopeEvidenceLedger`).
  `phaseResources(... resolveScope(...))` at :10951 is another example.
- Impact: if `scopeRequirements` drops or renames a requirement derived from the plan or map
  format, the fixture reports exactly the wrong set and the "every requirement evidenced"
  gate still passes. These are the tests that are supposed to protect plan/roadmap format
  fidelity, which the operator calls ground truth.
- Recommendation: expected requirement and case IDs should be literals taken from the fixture
  plan/map (e.g. the `fixtures/concurrency/*.zip` sources, or an inline small map), asserted
  once against `scopeRequirements` in a focused unit test. Scenario tests then use the literal
  list. Keep production helpers out of the "arrange" step of scenario tests.
- Effort: S
- Related: QA-01
- Plan/roadmap format impact: none (improves protection of the formats)

### QA-07: The test/production boundary is structural only in `packages/git`; everywhere else tests and test-support compile into `dist`
- Severity: low
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - Every package `tsconfig.json` has `"include": ["src"]`. 110 `*.test.js` files are emitted
    under `packages/*/dist` and `apps/server/dist`.
  - `packages/{planning,storage}/dist/test-support.js` and `apps/server/dist/test-support.js`
    exist.
  - Test-support modules in `src`: `apps/server/src/{test-support,multipart-test-support}.ts`,
    `packages/planning/src/{test-support,archive-test-support}.ts`,
    `packages/storage/src/{test-support,planning-test-support,repository-test-support}.ts`.
  - The e2e harness entry `apps/server/src/e2e-entry.ts` is also in the production root.
  - Only `packages/git/test/` follows ADR-008's CT-04A1 decision.
  - Mitigation: none of them is reachable from a package `index.ts` (checked).
- Impact: this is the inconsistency the operator already decided against. It is also what
  forces QA-04's filename patterns.
- Recommendation: move every test and test-support module to `<pkg>/test/` (mirroring the
  `packages/git` precedent). Add a `tsconfig.test.json` per package (or one root one) for
  typechecking. Point Vitest `include` at `*/test/**`. Then simplify `check:scope` (QA-04).
  Do it together with the QA-01 split.
- Effort: M (mechanical)
- Related: QA-01, QA-04
- Plan/roadmap format impact: none

### QA-08: Unit tests depend on host tool paths and create fixtures inside the repository
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - `/usr/bin/git`: `packages/agents/src/local-check.test.ts:27,36`, `pinned-cargo.test.ts:47,74`,
    `baseline-preparation.test.ts:90`, `server-execution.test.ts:7765`.
  - `join(homedir(), '.cargo/bin/cargo')`: `pinned-cargo.test.ts:35`, `historical-cargo.test.ts:30`.
  - The suite really invokes cargo (stderr shows `Locking 1 package…`/`patch ct_runtime_provider`
    warnings).
  - No `skipIf` exists anywhere.
  - `packages/git/test/test-support.ts:91` and `repository-inspector.test.ts:431` create
    `mkdtemp(join(process.cwd(), '.ct04a-…'))`, i.e. inside the repository. A leaked fixture
    `.ct04a-git-test-iJlU8M/` (2026-09-09, a full nested git repo) remains at the repo root,
    hidden only by `.gitignore:27`.
- Impact:
  - `pnpm check` ("CI-equivalent") only passes on a machine with rustup at `~/.cargo` and git
    at `/usr/bin`, which contradicts CONTRIBUTING's reproducibility claim.
  - Fixtures inside the worktree can be picked up by tools, and by git if the ignore rule
    changes.
  - If the fixture's own `git init` failed, a nested fixture would operate on the
    CraftingTable repository.
- Recommendation:
  - Resolve tools the way production does (the config's PATH search) through one shared
    test helper, and fail with a clear "requires cargo" message, or mark those tests with
    `describe.skipIf(!cargo)` and make the gate require them explicitly.
  - Move fixture roots to `os.tmpdir()`. The ceiling-directory logic already protects
    discovery; if the in-repo location was chosen for path-policy reasons, document the reason.
  - Remove the leaked directory.
- Effort: S
- Related: DOC-03 (CONTRIBUTING claims)
- Plan/roadmap format impact: none

### QA-09: Lint warnings do not gate the build, and 666 have accumulated
- Severity: low
- Category: testing
- Status: CONFIRMED
- Evidence: `biome lint .` → "Found 666 warnings. Found 11 infos." The largest rule is
  `lint/style/noNonNullAssertion` with 645. By file: `server-execution.test.ts` 350,
  `roadmap-service.ts` 47, `runtime-evidence-service.ts` 46, `work-cycle-service.ts` 28,
  `map-amendment-service.ts` 19, and 2 `noUnusedImports`. `biome.json` uses the recommended
  preset without error-level promotion.
- Impact:
  - About 180 non-null assertions in production controller services are unchecked
    assumptions on exactly the code that orchestrates state.
  - A warning count this high hides any new, meaningful warning.
- Recommendation:
  - Set `noNonNullAssertion` to `error` for `apps/*/src` and `packages/*/src` production files
    (a test override can stay `off`).
  - Fix the production occurrences, most of them `find(...)!` on storage lookups that should
    raise typed `NotFound`/invariant errors.
  - Run `biome lint --error-on-warnings` in `pnpm check`.
- Effort: S–M
- Related: controller findings
- Plan/roadmap format impact: none

### QA-10: Test effort is weighted toward the dormant CT-04A repository-inspection feature
- Severity: low
- Category: dead-code
- Status: CONFIRMED (feature disabled in the operator's deployment). Whether it is dead is a
  HYPOTHESIS; the architecture review should confirm.
- Evidence:
  - `apps/server/src/config.ts:165–167` disables the "repository feature" unless one of the
    `CRAFTINGTABLE_REPOSITORY_ROOTS`/`GIT_BIN`/`GIT_SEARCH_PATH`/`GIT_*_TIMEOUT_MS`… variables
    is set. The operator's `~/.config/craftingtable/env` sets only HOST, PORT, PUBLIC_ORIGIN,
    LOG_LEVEL and DEVELOPMENT_CAPACITY (key names only were read).
  - Tests for that path: `packages/git/test/repository-inspector.test.ts` (614),
    `packages/storage/src/repository-{schema,repositories,transitions}.test.ts` (656+572+434),
    `migration-000{2,3,4}.test.ts` (about 1,500), `repository-observation-adapter.test.ts`
    (442), and `repository-inspector-provider.test.ts`. That is roughly 4,500 test lines.
  - The feature has its own parallel env vocabulary: `CRAFTINGTABLE_GIT_BIN` vs the execution
    `CRAFTINGTABLE_GIT_EXECUTABLE`, `CRAFTINGTABLE_MANAGED_WORKTREE_ROOT` vs
    `CRAFTINGTABLE_WORKTREE_ROOT`.
  - ADRs 016–019 describe it.
- Impact: maintenance and suite time go to a path the operator does not run, while the running
  controller path is tested by one monolithic file. Duplicate configuration vocabulary
  confuses operators and agents.
- Recommendation: decide whether CT-04A inspection is on the roadmap. If not, remove the
  feature, its config, its tests and ADRs 016–019 (migrations stay: they are history). If yes,
  merge its configuration into the execution configuration (one Git executable, one worktree
  root).
- Effort: M
- Related: DOC-04, architecture findings
- Plan/roadmap format impact: none

### DOC-01: The README is a feature changelog, not an operator guide
- Severity: medium
- Category: docs
- Status: CONFIRMED
- Evidence:
  - `README.md` 600 lines / 6,322 words.
  - `## What works today` runs lines 12–396: 34 bolded paragraphs such as "Controller
    obligations and clear decisions" and "Shared decision review", each 6–25 lines of UI
    path and ADR detail.
  - Quickstart only begins at line 397.
  - `## Non-goals` (:534) is followed by `### Resolving design questions` (:542, an H3 under
    Non-goals) and `## Managed native verification` (:581). Both are appended feature docs.
  - 72 commits touched README.md; recent commits each add 8–19 lines.
- Impact: the operator's pain point about "many paths to the same places" shows up in the
  documentation too. A new reader or agent cannot find how to run, operate or reason about
  the system without reading 6k words of feature deltas. Stale statements hide in the mass
  (DOC-03).
- Recommendation: restructure to about 150 lines:
  1. What it is (5 lines) and a one-paragraph mental model (plan → roadmap → work item/slice
     → cycle → run → review → merge → finalization; who decides what).
  2. Quickstart.
  3. Daily use: links to a new `docs/user-guide.md` organised by *task* ("resolve a
     blocked item", "answer a decision", "approve a merge/promotion", "recover a failed run").
  4. Configuration (generated or verified list; DOC-03).
  5. Where things are.
  6. Non-goals.
  Move the per-feature paragraphs into the user guide under the task they serve, and cut
  everything that restates an ADR. Add a rule to AGENTS.md: the README is not updated per
  feature; the user guide is updated per *task* changed.
- Effort: M
- Related: DOC-02, DOC-05, UI unification findings (the task list is the same list the UI
  should unify)
- Plan/roadmap format impact: none

### DOC-02: ADR sprawl — 65 records, broken index, inconsistent status metadata, long refinement chains
- Severity: medium
- Category: docs
- Status: CONFIRMED
- Evidence:
  - Naming: `ADR-001…032`, `ADR-051…056`, `058…065` vs bare `033…050`, `057`. Status formats:
    `- **Status:** accepted`, `Status: accepted. Date:`, `- Status: accepted`, `Status: Accepted`,
    `Accepted: 2026-09-19` (ADR-059, ADR-065 have no "Status" line).
  - `docs/decisions/README.md` lists only 001–032 and 051, with 052 and 053 as trailing links.
    It omits 033–050 and 054–065 (30 records).
  - Superseded or partial: ADR-004 (decided in 020), 005 (→022), 006 (→020), 007 (→020),
    014 (→021), 022 (partly →023), **031** (its scratch retention is superseded by
    034 per `034-storage-placement-and-retention.md:23`, but its header still says
    "accepted"), and 028 is "proposed" although roadmaps shipped.
  - Refinement chains:
    - finalization: 033 → 035 → 036 → 038 → 040 → 041 → 042 → 049 → 050 (each header says
      "Refines ADR-033…");
    - recovery: 037, 051, 056, 057, 062 (plus 052, 059 and 060, which touch it).
  - Stale ADR content: ADR-008 (DOC-03).
  - 65 files, about 27,900 words.
- Impact: to learn the *current* finalization rule you must read nine ADRs in order and
  mentally apply each delta. Agents citing an ADR may cite a superseded one. The index is
  useless.
- Recommendation (keep ADRs immutable as history, add a current-state layer):
  1. Normalise file names to `ADR-NNN-*.md` and headers to one format (`Status:`,
     `Date:`, `Supersedes:`, `Refines:`). A 30-line `scripts/check-adrs.mjs` in `pnpm check`
     can verify format and regenerate the index. The index is a derived artifact, so it
     cannot drift.
  2. Move superseded ADRs (004, 005, 006, 007, 014, and 022 when 023 fully covers it) into
     `docs/decisions/superseded/`. This is a structural boundary: current ADRs are what is in
     the top directory.
  3. Write about 8 topic pages under `docs/design/`, each the *current* rule with links to its
     ADRs:
     - platform and toolchain (001, 002, 008);
     - auth and security (009);
     - events and audit (003, 010, 013);
     - planning model (011, 012, 015, 044);
     - agents and runs (020, 022, 023, 062, 064);
     - work-item lifecycle, cycles, recovery and decisions (021, 024, 025, 037, 051, 052,
       056, 059, 060, 063);
     - integration and roadmaps (026, 028–030, 032, 033, 046, 057, 065);
     - finalization (035, 036, 038, 040–042, 049, 050);
     - cross-project maps and verification (043, 045, 047, 048, 053–055, 058, 061);
     - storage (031, 034, 039).
     `docs/architecture.md` shrinks to the package map plus links to these pages.
  4. Fix ADR-031's and ADR-028's statuses.
  5. Decide ADR-016–019 with QA-10.
- Effort: M
- Related: DOC-01, DOC-05, QA-10
- Plan/roadmap format impact: none

### DOC-03: Doc claims out of sync with code (spot-check of 14 claims: 7 false or stale)
- Severity: medium
- Category: docs
- Status: CONFIRMED
- Evidence (false or stale):
  1. `README.md:420` "`pnpm db:migrate` applies schema 22". `packages/storage/migrations/` has
     26 (`0026-agent-profiles.sql`).
  2. README configuration table (:490–509) omits variables that `apps/server/src/config.ts`
     reads:
     - `CRAFTINGTABLE_REPOSITORY_ROOTS` (:173), `GIT_BIN` (:179), `GIT_SEARCH_PATH` (:180);
     - `GIT_TIMEOUT_MS`/`GIT_CREATION_TIMEOUT_MS`/`GIT_INSPECTION_TIMEOUT_MS`/`GIT_STDOUT_LIMIT_BYTES`/
       `GIT_STDERR_LIMIT_BYTES`/`GIT_TERMINATION_GRACE_MS` (:219–274);
     - `REPOSITORY_PROVIDER_RETRY_DELAY_MS` (:281), `ARTIFACT_ROOT`, `MANAGED_WORKTREE_ROOT`
       (:204–205);
     - `DEVELOPMENT_CAPACITY`/`VERIFICATION_CAPACITY` (:344; only mentioned in prose);
     - `CRAFTINGTABLE_ACT_CONFIG` (`runtime-evidence-service.ts:2265`) and
       `CRAFTINGTABLE_KATA_READINESS`, both used by the operator's own systemd drop-ins.
  3. `docs/architecture.md:20–23` lists 5 process-authority modules. The script
     (`check-forbidden-scope.mjs:44–58`) has 6; `packages/agents/src/native-environment.ts`
     (ADR-054) is missing.
  4. `ADR-008:19` "Playwright runs one chromium-only authenticated flow". There are 11 specs and
     a mobile project.
  5. `ADR-008:33–34` "fails … on a production import of the `agents`/`git`/`testing` seams".
     This was removed in `3f3441c`, and the `testing` package no longer exists.
  6. `ADR-008:44–46` "a production filename containing `test-support` gains no authority". The
     code grants exactly that (QA-04).
  7. `docs/ui-principles.md:103` "A bare 'Ready', 'Blocked'… never appears".
     `apps/web/src/features/planning/ProjectCards.tsx:51,55` render `<dt>Ready</dt>` and
     `<dt>Blocked</dt>`.
  - Also: AGENTS.md:30 says superseded artifacts live in `archive/`, but CT-01..03 artifacts
    are at the root (REPO-03). `docs/decisions/README.md` is stale (DOC-02).
- Evidence (accurate): run statuses and roles (`packages/domain/src/execution.ts:114–138`);
  handoff limits of 256 KiB and 32 MiB (`agent-run-service.ts:110`, `run-handoff.ts:200`);
  "only storage owns SQL"; web depends only on domain and contracts; four cycle steps
  (`work-cycle.ts:11`); the systemd unit in `operations.md:117–130` matches the installed
  unit; the e2e ports 4610/5183.
- Impact: agents are told to read these documents first (AGENTS.md read order), so stale
  claims turn into wrong decisions. The operator is told schema 22 when upgrading.
- Recommendation:
  - Fix the seven items.
  - Generate the configuration table from a single `ENVIRONMENT_VARIABLES` descriptor in
    `config.ts` (name, default, meaning), with a unit test asserting that the README table
    matches, or render `pnpm craftingtable config --help` into the docs.
  - Make architecture.md reference the `PROCESS_AUTHORITY` map instead of restating it.
  - Replace "schema N" with "the latest schema".
- Effort: S
- Related: DOC-01, DOC-02, QA-04
- Plan/roadmap format impact: none

### DOC-04: Vocabulary is incoherent around blockers, decisions and recovery
- Severity: medium
- Category: docs / ux
- Status: CONFIRMED (inventory). The mapping to UI fragmentation is shared with the UI review.
- Evidence:
  - Recovery flavours named in docs and ADR titles: design recovery, scope recovery, scope
    repair, owning-slice recovery, roadmap scope recovery, checkpoint recovery, background
    completion recovery, provider recovery, finalization recovery, cycle guidance recovery,
    cycle remediation recovery, merge recovery.
  - Decision and attention concepts: operator decisions, operator questions, genuine
    decisions, shared architecture/design decisions, design questions, controller
    obligations, attention notifications, `needs-attention`, finding decisions, stage
    decisions.
  - Matching UI components: `CheckpointRecoveryPanel`, `CycleGuidanceRecovery`,
    `CycleRemediationRecovery`, `DesignRecoveryPanel`, `FinalizationRecoveryAgent`,
    `ProviderRecovery`, `ScopeRepairPanel`, `ScopeReviewRecovery`, `ScopeRecoveryPanel`,
    `SharedDecisionInbox`, `ArchitectureDecisionPanel`, `DecisionPreparationPanel`,
    `FinalizationStageDecision`, `RoadmapAttention`, `AttentionStrip`.
  - Server services: `architecture-decision-inbox`, `architecture-decision-policy`,
    `decision-preparation-policy`, `design-recovery`, `operator-decisions`,
    `scope-recovery-policy`, `scope-repair`.
  - Parallel configuration vocabulary: `GIT_BIN`/`GIT_EXECUTABLE`,
    `MANAGED_WORKTREE_ROOT`/`WORKTREE_ROOT` (QA-10).
  - `ui-principles.md:74–103` defines vocabulary only for work items and merge readiness.
    Nothing defines the blocker/decision taxonomy that ADR-063 introduced.
- Impact: this is the documentation side of pain point 1. Each recovery was named when it was
  built, so there is no closed set of "kinds of blockage" and "kinds of decision" that the UI
  could unify around.
- Recommendation: add a normative glossary (in `ui-principles.md` "Vocabulary", mirrored by a
  closed domain enum) with:
  - **Blocker kinds**: waiting on dependency, waiting on resource, controller retrying,
    agent defect to remediate, needs operator decision, needs operator authorization,
    exhausted/needs intervention;
  - **Decision kinds**: design/architecture choice, plan conflict, authorization/approval,
    finding disposition, promotion.
  Each recovery flow becomes an *action* on a blocker kind. Deprecate names that are not in
  the glossary.
- Effort: M (docs S; aligning code is part of the UI/controller work)
- Related: UI unification findings, ADR-063
- Plan/roadmap format impact: none (wire vocabulary may change; plan and map formats do not)

### DOC-05: "Principles", security and operations docs have become per-feature narratives
- Severity: low
- Category: docs
- Status: CONFIRMED
- Evidence:
  - `docs/ui-principles.md` "Cross-project import drafts" runs :191–306 (116 lines of feature
    behaviour) inside a principles document. "Page anatomy" (:31) is the part that is actually
    normative.
  - `docs/security.md` has 17 sections, many per feature ("Background completion recovery"
    :226, "Operational agent selections" :435).
  - `docs/operations.md` has "Sequential roadmaps" and "Parallel roadmaps" (:294, :339) as
    usage guides.
  - `docs/finalization-roadmap.md` ("Status: implemented"), `docs/cross-project-roadmap.md`
    ("delivered; tracked implementation backlog complete") and
    `docs/plans/2026-09-09-codex-backend.md` ("Historical implementation plan … superseded")
    are completed planning documents. AGENTS.md:36–38 says the repo does not want these.
- Impact: every feature is described in three to five places with slightly different wording,
  which multiplies drift (DOC-03). Principles get buried.
- Recommendation:
  - Keep `ui-principles.md` to principles, anatomy and vocabulary, and move feature behaviour
    to the user guide (DOC-01).
  - Restructure `security.md` around trust boundaries and authorities (network, credentials,
    process authority, merge/promotion authority, untrusted input). Features cite the
    authority they use instead of restating it.
  - Move the two roadmap documents and `docs/plans/` to `archive/`.
- Effort: M
- Related: DOC-01, DOC-02
- Plan/roadmap format impact: none

### DOC-06: AGENTS.md mandates repository-bloating captures
- Severity: low
- Category: docs
- Status: CONFIRMED
- Evidence: AGENTS.md:42–48 ("Capture a new version before and after any UI change that alters
  page structure … They record how the UI looked at a commit"). Agents have followed this
  literally: 55 captures in 6 days, with before/after pairs around each feature commit.
- Impact: this rule causes REPO-01.
- Recommendation: rewrite the paragraph when REPO-01 lands: captures go to the external
  capture root, and one capture per UI-changing commit ("after") is enough, since the
  previous commit's "after" is the "before". Only the text index is committed.
- Effort: S
- Related: REPO-01
- Plan/roadmap format impact: none

### REPO-03: Legacy process directories and branches are still at top level
- Severity: low
- Category: simplification
- Status: CONFIRMED
- Evidence:
  - Root directories last touched in July: `review-findings/` (CT-01..03, 8 files, last
    `3b701fe` 2026-07-24), `implementation-reports/` (8 files, `195dd8d` 2026-07-24),
    `work-items/` (13 files, `49499b9` 2026-09-04).
  - The CT-04 equivalents already live in `archive/CT-04/`. `git grep` finds no code or doc
    reference outside themselves.
  - Untracked leftovers: `packages/testing/` (only `dist/`, `node_modules/`, `tsbuildinfo`
    from 2026-07-22/08-12; the package was removed in `3f3441c`) and `.ct04a-git-test-iJlU8M/`
    (QA-08).
  - Local branches, all merged into main: `ct-02-persistent-daemon`, `ct-03-plan-dashboard`,
    `ct-04`, `ct-04a2a-repository-model`, `ct=04a2b1-repository-journal` (malformed name),
    `ct-04a2b2a-repository-evidence-boundary`, `ct-04a-git-foundation`.
  - `init/` is legitimately kept per AGENTS.md:28–31.
- Impact: noise for agents that list the root. AGENTS.md read order and the "no work contracts"
  rule contradict what sits at the top level.
- Recommendation:
  - `git mv review-findings implementation-reports work-items archive/CT-01-03/`.
  - Delete `packages/testing/` and the fixture directory.
  - With operator consent, delete the 7 merged local branches (and `origin/ct-04a-git-foundation`).
- Effort: S
- Related: DOC-05
- Plan/roadmap format impact: none

### REPO-04: The production daemon runs from the development checkout and its build output
- Severity: medium
- Category: reliability
- Status: CONFIRMED (configuration). The consequences described below are inferred.
- Evidence:
  - `~/.config/systemd/user/craftingtable.service`: `WorkingDirectory=%h/src/craftingtable`,
    `ExecStart=/usr/bin/env pnpm start` → `apps/server` `tsx src/index.ts`.
  - Workspace packages resolve through `"exports"` to `./dist/index.js`
    (e.g. `packages/storage/package.json`).
  - `pnpm check`, `pnpm test:e2e`, `pnpm ui:walkthrough` and `pnpm dev` all run `tsc -b`, which
    rewrites `packages/*/dist` in place.
  - Agents supervised by CraftingTable, and review agents like this one, work in this same
    checkout.
- Impact:
  - A restart of the live daemon (including `Restart=on-failure` after a crash) picks up
    whatever `apps/server/src` and `packages/*/dist` contain at that moment. That can include
    uncommitted or half-built work from an agent session, or a `dist` built from a different
    tree state than `src`.
  - The 1.5 GB of captures and the test-fixture directories share the production directory.
  - Reviewers must avoid `pnpm typecheck` for fear of changing production. This review did.
- Recommendation:
  - Deploy from a separate, clean worktree or an exported build, e.g.
    `git worktree add ~/.local/share/craftingtable/app <tag>` followed by
    `pnpm install --frozen-lockfile && pnpm build`, with the unit's `WorkingDirectory`
    pointing there.
  - Add a `pnpm deploy:local <ref>` script that builds and restarts explicitly.
  - Development then never mutates production. This is also a structural boundary.
- Effort: S
- Related: ops reviewer findings, REPO-01
- Plan/roadmap format impact: none

## Remediation direction

Sequence, cheapest and most leveraged first:

1. **Before anything is pushed (operator-run):**
   - REPO-01: move the capture root outside the repository and make captures deterministic.
   - DOC-06: rewrite the AGENTS.md rule.
   - Strip `docs/ui-walkthrough` from the unpublished `origin/main..main` range and gc.
   - Push (REPO-02).
   - Then REPO-04: deploy from a separate worktree, so later refactors (controller split,
     test moves) cannot perturb the live daemon.
2. **Make the gate fast and honest (about 2–3 days):**
   - QA-01: split `server-execution.test.ts` by aggregate, with its harness under
     `apps/server/test/`.
   - Together with QA-07: move all tests and test-support to `<pkg>/test/`.
   - Which enables QA-04: a structural `check:scope`, with allowlists restored.
   - QA-05: remove the gate screenshots and add shared e2e helpers.
   - QA-08: tool resolution and fixture locations.
   - QA-09: warnings as errors in production code.
   Target: `pnpm test` under 90 s, the whole `pnpm check` under 5 minutes, and zero lint
   warnings.
3. **Close the authorization gap (QA-03):** a route-table-driven auth sweep now, then
   declarative route authority.
4. **Coordinate with the controller refactor:**
   - QA-02: an injected scheduler/clock and `idle()`, then replace the 234 `waitFor` polls.
   - QA-06: literal expectations from fixture plans and maps.
   - QA-10: decide on the CT-04A inspection feature.
   The split test files from step 2 become the per-aggregate safety net for decomposing
   `work-cycle-service`/`roadmap-service`. Do step 2 *before* the controller refactor.
5. **Documentation reset (after the UI/controller vocabulary settles):**
   - DOC-04 glossary first; it is the contract that the UI unification will implement.
   - Then DOC-01 (README → about 150 lines + a task-oriented user guide).
   - DOC-02 (normalised ADRs, generated index, `superseded/` directory, topic pages).
   - DOC-05 (principles and security by boundary; archive the planning documents).
   - DOC-03 fixes can land immediately.
   - REPO-03 cleanup at any time.

Target end state:
- Every package has `src/` (production only) and `test/` (tests, fixtures, harness).
- The controller is testable through a deterministic step/idle seam.
- Test files are organised one per aggregate, each under about 1,500 lines.
- Authority rules are enforced by structure: directory roots, declarative route
  authority, and TypeScript project boundaries.
- The repository contains source and text only. UI history lives beside it.
- Documentation has a small, derived, verifiable core: generated configuration table and ADR
  index, a glossary, and topic "current decision" pages. There is no per-feature changelog
  prose.
