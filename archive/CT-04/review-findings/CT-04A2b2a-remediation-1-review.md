# CT-04A2b2a Remediation 1 Independent Review

**Verdict:** `APPROVE`

**Remediation head under review:** `0c2e9ba68abecd904bae81a9faae5074b4e29fb6`

**Prior review:** `review-findings/CT-04/CT-04A2b2a-code-review.md`, SHA-256
`08c1cb3918c7aedc0c29c7037018481e2c3a0c990898546f630c538e098204b4`

**Operator disposition:** `work-items/CT-04/CT-04A2b2a-review-disposition.md`

**Date:** 2026-08-12

## 1. Lineage and process — pass

```text
97af7753  implementation under original review
87964221  docs: add CT-04A2b2a implementation report
0c2e9ba6  ct-04a2b2a: remediate implementation review   <- head under review
aff23da8  docs: record CT-04A2b2a remediation head
```

The remediation commit has the implementation-report commit as its first parent; the
exact-head remediation commit report is introduced afterwards and does not amend it. The
prior review is committed verbatim — its recomputed SHA-256 matches the value the
disposition and both remediation reports pin. Worktree clean.

The accepted plan was amended (`451429f6acca20a1812c2cd18ad79fd3eaab912a8ebb5ded53334833dc3fe02b`,
matching the pinned value). The amendment is dated, explicitly labelled a consistency
amendment, and confined to the O-2 and O-4 text. Protected specifications, the A2b2
supplement, and later-child contracts are untouched.

## 2. Finding closure

### F-01 — CLOSED

`repository-observation-adapter.test.ts:43-45` now captures A1's real ordered code array,
subject record, and risk-signal array from `importOriginal()` into `realCodes` /
`realSubjects` / `realSignals`. Those containers are written **only** there — verified by
grep, so no path repopulates them from domain. `beforeEach` (`:180-185`) restores the
mutable drift containers from the real fixtures instead of the domain constants, and the
positive test (`:190-192`) asserts each real A1 export equals its domain counterpart
before calling `repositoryObservationVocabularyMatches()`.

The tautology is gone: real A1 vocabulary drift now fails the positive proof rather than
silently latching every enabled deployment `permanently-unavailable` at runtime. Accepted
plan §8's "positive tests use the real package root" is satisfied literally.

### F-02 — CLOSED

`check-ct04-protected-package.mjs:213-246` adds an explicit 31-ID declared-closed
register, independent of the 7-ID residual map, and `:406-425`
(`a2b2aClosureRegisterViolations`) is wired live at `:462`. Executed against the real
supplement:

```text
protected 38   closed 31   residual 7   overlap closed∩residual: []
LIVE default:                            []
declare B2-CFG-003 closed:               ['B2-CFG-003 retains a B2b residual and cannot be closed by A2b2a']
drop B2-SCOPE-001 from register:         ['B2-SCOPE-001 has no A2b2a closure or B2b-residual disposition']
```

The guard is now effective in both directions and additionally rejects an invented ID.
`check-ct04-protected-package.test.mjs:270-296` exercises all three failure modes through
the same function the gate calls.

## 3. Observation reconciliation

| Obs | Disposition | Verified at |
|---|---|---|
| O-1 | Adopted | `repository-observation-adapter.ts:462-475` — both exact UTF-8 digests verified before either `JSON.parse`; ordering now matches `verifyStored` |
| O-2 | Documentary + proof correction | accepted plan §5.3/§14 and `docs/operations.md` restate the real synchronous-failure behavior; `config.test.ts:89` adds `/srv/repositories:colon`; provider test title (`repository-inspector-provider.test.ts:97`) narrowed to the `configuration-required` case it actually constructs |
| O-3 | Adopted | `config.test.ts:88` adds the NUL-bearing root to the lexical matrix |
| O-4 | Strengthened past the ask | `repository-observation-policy.ts:83-121` adds an exhaustive compile-time `Record<A1Code, readonly A1Operation[]>`; `:243` requires the actual operation to be in the code-specific set; `repository-observation-policy.test.ts:103-113` generates every accepted pair and `:92` rejects a known-but-wrong operation |
| O-5 | Adopted | `check-forbidden-scope.mjs:429-444` resolves relative specifiers against the repository root and rejects cross-package targets under `packages/git`, exempting A1's own internal imports; covered by a direct unit test and an end-to-end scratch-repo `runCheck` fixture (`check-forbidden-scope.test.mjs:208-244`) |

**O-4 correctness independently verified.** A too-narrow operation table would convert
real A1 failures into permanent latches, so I enumerated every `createInspectionError`
call site in `packages/git/src/` against the new table. The command runner selects its
operation at `command-runner.ts:162` (`version` → `create-inspector`, else
`inspect-path`), and every code it can emit generically — `git-executable-changed`,
`spawn-failed`, `timed-out`, `stdout-overflow`, `stderr-overflow`, `signal-terminated`,
`git-command-failed` — carries both operations in the table. The one entry that could
have been too narrow, `aborted: ['inspect-path']`, is correct:
`RepositoryInspectorOptions` (`types.ts:70-80`) exposes no caller signal, and the
creation controller aborts only with `CREATION_TIMEOUT_REASON`
(`configuration.ts:310-313`), which `abortCode` (`command-runner.ts:117-121`) maps to
`timed-out`. All configuration-, path-policy-, inspector-, and comparison-owned codes use
literal operations that match the table exactly.

## 4. Gate and boundary re-verification at the remediation head

`pnpm check` — exit 0:

```text
format:check passed / lint passed / typecheck passed / build passed
72 Vitest files passed / 646 Vitest tests passed
4 Playwright tests passed
check:scope passed / check:protected passed
```

The 646 count reflects exactly the two added tests (per-code operation validity, relative
traversal); all other remediation work extended existing cases in place.

- `git diff --exit-code 886ddded aff23da8 --` over `protected/`, `packages/git/src/`,
  `packages/contracts/`, `packages/storage/`, `apps/server/src/routes/`,
  `apps/server/src/server.ts`, `apps/server/src/route-inventory.test.ts`, `apps/web/`,
  `packages/domain/src/workspace-events.ts`, and the A2b2 supplement reports the single
  approved D-01(a) `calculateCoreIdentityFingerprint` re-export in
  `packages/git/src/index.ts` and nothing else.
- The sole production `@craftingtable/git` import remains
  `apps/server/src/services/repository-observation-adapter.ts:18`.
- The remediation touches only six A2b2a source/test files, the two gate pairs,
  `docs/operations.md`, and process artifacts. A keyword sweep of the added lines finds no
  route, authorization, audit, event, notifier, binding, retirement, worktree, branch,
  directory-creation, or storage-mutation surface. No CT-04B+ capability leaked.

## 5. Disposition

Both changes-required findings are closed with mechanisms I re-derived independently
rather than accepting on assertion: F-01's parity proof is no longer self-comparing, and
F-02's guard fires under injected drift in both directions. All five observations are
reconciled, one of them (O-4) beyond what I asked for and verified correct against A1's
actual error-construction sites. Scope, frozen surfaces, and the authority boundary are
unchanged.

`APPROVE` at `0c2e9ba68abecd904bae81a9faae5074b4e29fb6`.
