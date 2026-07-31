# CT-04A2b1 remediation 1 independent review

Reviewed remediation head: `20235b33293c1dd872afcf85ccf3389ccf49633d`
Report-only commit at review time: `769fc0807564d4790075bcd0fb265da23e8745b8`
Review-record base: `7c8bcd34c0c4822e1b37cf2f2ea05acc7d9c4056`
Reviewed implementation head: `0c3d53a00cc004c99248abb227110293f829b722`
Initial review: `review-findings/CT-04/CT-04A2b1-initial-review.md`
(SHA-256 `b8a70cb1793775d93b72b8923d01242e55751eb25d1621b1213a3eb07e1d2f66`)
Operator disposition: `work-items/CT-04/CT-04A2b1-initial-review-disposition.md`
Amended migration 0004 SHA-256:
`409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e`

Review checkout: `769fc08`, branch `ct=04a2b1-repository-journal`, working tree clean
before and after. `git diff 20235b3 769fc08` touches only the remediation commit report,
so the reviewed code head is `20235b3`. Local environment: Node `v26.2.0`, Vitest
`4.1.10`, Zod `4.4.3`, POSIX, non-root UID `1000`. Every probe ran from a scratch
directory outside the repository, against temporary SQLite databases, a `git archive`
extract, and isolated `git clone` copies. Nothing in the repository was modified by this
review.

**This document is introduced after `769fc08`.** The verdict binds to that exact head.
Any further remediation invalidates it.

## Verdict

**CHANGES REQUIRED — one narrow item.**

Six of the seven directed items are closed and independently verified. `B1-R-02` is
partially closed: the carve-out covers one of two root-level scratch namespaces created by
`packages/git` tests, and the identical `B1-SCOPE-005` failure remains reachable through
the second. One new advisory, `B1-A-07`, is recorded.

The substantive slice is unchanged and remains sound. All 45 probes from the initial
review pass against the amended migration, plus 4 new guard-mutation probes — 49 of 49.

## Re-verified basis

| Item | Result |
|---|---|
| Initial review pin `b8a70cb1…` | matches the committed file byte-for-byte; unmodified by remediation |
| Migrations 0001, 0002, 0003 | byte-identical |
| Migration 0004 | `409553eb…af5f29e`, matches the remediation report |
| CT-04 protected specification, A2 and A2b supplements | byte-identical |
| A2a state primitives, A1 production source | unchanged |
| Manifests, lockfile, server production files, routes, services | unchanged |
| `pnpm check` at this head | green: 68 files / 607 tests, 4 Playwright, `check:scope`, `check:protected` |

## Closed items

### `B1-R-01` — closed

`[^'"\n;]+?` → `[^;'"]*?` restores newline spanning in `IMPORT_PATTERN`.

End-to-end on a `git archive` extract of this head, injecting into
`packages/storage/src/repositories/workspace-events.ts`:

```text
BASELINE clean head                          -> []
MULTI-LINE poison (the former bypass)        -> 4 violations
```

The four violations are identical to those the single-line control produced during the
initial review, so the gate no longer depends on formatting.

Parity check across **every** tracked `.ts`, `.tsx`, `.mjs` and `.js` file: the repaired
pattern misses no real specifier that the pre-B1 pattern caught. The only two divergences
are prose inside string literals that the pre-B1 pattern captured spuriously
(`"corrected by an effect"`, `"beta"`).

Adversarial form coverage: 15 of 21 probed import spellings newly detected, including
multi-line value, `type`, inline-`type`-specifier, default, namespace, side-effect,
`export … from`, `export *`, `export type … from`, newline-before-brace, and
no-trailing-semicolon variants, in both quote styles.

The added fixtures at `scripts/check-forbidden-scope.test.mjs` are genuinely adversarial
and end-to-end: one asserts `findImports`/`findForbiddenImports` over a Biome-formatted
multi-line block, and one asserts the complete four-violation `runCheck` result for
multi-line process and Git imports in a B1 exact-path file. This satisfies the initial
review's requirement that the repair be proven rather than asserted.

### `B1-A-01` — closed

Accepted plan §3 amended to a 31-file exact tree including `apps/server/src/cli.test.ts`,
§18 updated, and a new Appendix B recording the disposition against the initial-review
SHA-256. The **contract** was amended, not only the gate, which was the substance of the
finding.

### `B1-A-02` — closed, and the guards are load-bearing

Migration 0004 gains `composite-foreign-key-catalog` and
`post-drop-composite-foreign-key-catalog` checkpoints: bilateral `EXCEPT` over parent
table, `on_delete`, part count, and exact column order via
`group_concat(… ORDER BY seq)`, with a total of six composite keys.

I did not take the guards on trust. Mutating the real migration bytes three ways, each
aborts the migration:

| Mutation | Result |
|---|---|
| Remove the `repository_inspections` composite key from `CREATE TABLE` | migration aborts |
| Weaken `registered_repositories` key to `ON DELETE NO ACTION` | migration aborts |
| Transpose two columns in the four-part binding key | migration aborts |
| Unmutated bytes (control) | migration succeeds, nine-row catalog |

Note for the record: `HAVING COUNT(*) > 1` scopes the guard to composite keys, so the
three single-column foreign keys (`workspaces`, `users`, `workspace_event_kinds`) are not
covered. That matches the plan's wording and is not a defect.

### `B1-A-03` — closed

Plan §12 narrowed to the five B1 repository descriptions with the reason stated, and the
`B1-UI-009` row updated. The test now asserts the 256-character bound at a maximum
120-character display name for all five repository kinds, and separately asserts that
legacy `plan-version-imported` with a 300-character document **exceeds** it — so the
limitation is pinned rather than merely unclaimed.

### `B1-A-06` — closed

`b1ChangedPathViolations` admits
`review-findings/CT-04/CT-04A2b1-(initial|remediation(-N)?)-review\.md`. Verified that the
initial, `remediation`, and `remediation-1` forms are admitted while
`CT-04A2b1-something-else.md` and `packages/git/src/runner.ts` are still rejected. `pnpm
check` is green at this head with the initial review artifact committed.

### `B1-A-04`, `B1-A-05` — no change, as dispositioned

Confirmed untouched.

## Open item

### `B1-R-02` — partially remediated (blocking)

The carve-out `^\.ct04a-git-test-[^/]+\/` correctly excludes the namespace created by
`packages/git/test/test-support.ts:89`, and is appropriately narrow — near-miss names such
as `.ct04a-git-testX/evil.ts` are still rejected.

It does not cover a **second** root-level scratch namespace created by
`packages/git/test/repository-inspector.test.ts:431`:

```js
const environmentRoot = mkdtempSync(join(process.cwd(), '.ct04a-hostile-home-'));
```

That fixture writes real files into the directory (`template/hooks/hostile-hook`,
`hostile/.gitconfig`), so `git ls-files --others --exclude-standard` lists them.
Reproduced deterministically in an isolated clone at this exact head:

```text
BASELINE                                     -> ok=true
.ct04a-git-test-Q/…        (remediated)      -> ok=true
.ct04a-hostile-home-Q/…    (uncovered)       -> ok=false
  B1-SCOPE-005 changed path is outside the accepted B1 tree: .ct04a-hostile-home-Q/hostile-gitconfig
  B1-SCOPE-005 changed path is outside the accepted B1 tree: .ct04a-hostile-home-Q/template/hooks/hostile-hook
```

The exposure window is not narrow. Polling the working tree during a
`repository-inspector.test.ts` run, the directory was present in **4000 of 4000 samples** —
essentially the full duration of that test file, comparable to the `.ct04a-git-test-`
window that was actually observed failing during the initial review.

The failure is currently latent: 8 of 8 full-suite runs passed at this head and `pnpm
check` is green. That is scheduling behaviour on this machine, not determinism. The
original `B1-R-02` also passed 5 of 8 runs before it was caught.

## New advisory

### `B1-A-07` — residual import-pattern evasion

A quote or apostrophe inside a comment **within** an import clause still blocks detection,
because `[^;'"]*?` cannot cross it:

```js
import {
  execFileSync, // don't
} from 'node:child_process';   // not detected
```

End-to-end this hides a real capability import: the injected `node:child_process` edge
produces no violation, while a neighbouring uncommented `@craftingtable/git` import is
still caught, so the evasion is per-statement.

Scope is genuinely narrow. No tracked file contains such a comment, no formatter produces
one, and this is not a regression — the pre-B1 pattern missed it too. The structural close
is to strip comments before scanning rather than widen the negated character class.
Advisory only; it should not hold acceptance.

## Direction for the implementer

Close `B1-R-02` with `.gitignore` rather than by extending the exclusion regex.
`git ls-files --others --exclude-standard` already honours `.gitignore`, so this uses
git's own exclusion machinery instead of maintaining a second enumeration inside the
checker, and it covers the whole `.ct04a-*` scratch class rather than the two names known
today.

Verified in an isolated clone at this head: with `.ct04a-*/` ignored, both scratch
namespaces disappear from the inventory and the only remaining error is `.gitignore`
itself being outside the allowlist.

Required changes:

1. `.gitignore` — add, under a comment identifying it as CT-04A test scratch:

   ```gitignore
   .ct04a-*/
   ```

2. `scripts/check-ct04-protected-package.mjs` — add `'.gitignore'` to
   `CT04A2B1_ALLOWED_CHANGED_PATHS`.

3. `scripts/check-ct04-protected-package.mjs` — remove the now-redundant
   `^\.ct04a-git-test-[^/]+\/` clause from `b1ChangedPathViolations`. Two mechanisms for
   one rule means a future failure of the `.gitignore` entry would be masked for one
   namespace and not the other. Retaining it is defensible if preferred, but it should
   then be a deliberate recorded choice.

4. `work-items/CT-04/CT-04A2b1-accepted-implementation-plan.md` — add `.gitignore` to the
   §3 exact tree, update the file count in §3 and §18, and record the amendment in the
   Appendix B disposition table, as was done for `apps/server/src/cli.test.ts`.

5. `scripts/check-ct04-protected-package.test.mjs` — add a regression assertion that
   **both** `.ct04a-git-test-<x>/…` and `.ct04a-hostile-home-<x>/…` are excluded from the
   inventory, and that a near-miss such as `.ct04a-git-testX/evil.ts` is still rejected.
   Without this the fix is asserted rather than proven, which is the same gap that let the
   original `B1-R-01` and `B1-R-02` through.

6. Record the change in a new immutable remediation report and rerun the complete gate.

`B1-A-07` is advisory; address it only if the operator disposes it for action.

## Recommended follow-up outside CT-04A2b1

The root cause is that `packages/git` tests create scratch directories inside the working
tree at all. Every other package already uses `mkdtempSync(join(tmpdir(), …))` —
`packages/storage` (five files), `apps/server` (four files), and both `scripts/*.test.mjs`.
`packages/git` is the sole outlier, at exactly two call sites.

I verified that the outlier has no technical reason to be one. With both call sites
pointed at `tmpdir()` in an isolated clone, the complete `packages/git` suite passes —
5 files, 64 tests — and no scratch directory appears in the working tree at all.

That change touches `packages/git/test/**`, which is CT-04A1 source, so it **must not** be
made under CT-04A2b1. It is recorded here as a candidate for its own small work item. Doing
it would make the `.gitignore` entry above dead but harmless.

One caveat worth carrying into that work item: `packages/git` exists to gather device and
inode evidence, and on Linux `/tmp` is commonly tmpfs, so fixtures there sit on a different
filesystem type than a real repository. Today's tests assert shape only
(`topLevelInode` against `/^[0-9]+$/`, with synthetic values in the comparison tests), so
this is currently harmless. If a future A1 test needs a fixture on the same device as the
repository, a sanctioned repo-local scratch directory becomes justified — and should then
be paired with making the inventory check read git's exclusion machinery rather than
enumerating names.

## Sequencing

The verdict binds to `769fc08` and any further remediation invalidates it. The `B1-R-02`
completion, and any advisory the operator disposes for action, should land in one
remediation turn against one new head.
