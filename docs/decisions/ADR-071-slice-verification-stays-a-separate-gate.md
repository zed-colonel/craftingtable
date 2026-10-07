# ADR-071: Slice verification stays a separate gate

Status: accepted
Date: 2026-10-07

## Context

A sliced work item is reviewed three times: the slice's own review before its merge, the
merged-slice verification after it, and the parent's acceptance. HIST-20 asked whether the
verification could be folded into the slice's final review when that review's profile already
satisfies the independent-reviewer role, since verification and acceptance entries were 60% of
the live roadmap (102 of 171) and each review brings its own stops.

The live record as of 2026-10-06 (register R-C7):

- Slice verification is 69 of the roadmap's 171 entries. So far it has run 14 cycles over 13
  slices, with 68 runs and 19 recovery stops.
- 7 of those stops were major findings that only verification caught, in 5 of the 13 slices
  (WI-01, EXO-01, WI-02 twice, EXO-02 twice, WI-03). The pre-merge review had passed each of
  them.
- The other 12 were a single minor finding with the exit gate met and the verdict mergeable
  (EXO-01/domain 8, EXO-02/domain 4), including the 2026-10-01/02 authorize, resume,
  investigate and pause chain.

## Decision

Slice verification is not folded into the slice's final review. It stays a separate gate run
on the merged integration tree by its own reviewer, as ADR-060 already requires ("merged-slice
verification, parent acceptance and final promotion remain separate gates"), and as the map's
`slice_lifecycle` declares. Scope evidence stays a decision command.

The 12 minor-only stops are addressed inside the gate instead: a verification whose gate is met
and whose verdict is mergeable records its evidence and keeps its minor and nit findings as
follow-ups on that evidence (R-C7 D7). Majors and failing gates still stop.

## Consequences

- The second independent look stays. On the record it is what found the majors in 5 of 13
  slices; folding would have merged those defects into the integration branch unseen until
  parent acceptance.
- Verification keeps its cost: one more review per slice. The stops it produces that were not
  decisions (a lone minor finding on a passing gate) no longer reach the operator.
- The map's acceptance-coverage semantics are unchanged: cases assigned to slice verification
  are still checked there, against the merged tree.

## Alternatives considered

- **Fold when the post-merge tree equals the reviewed candidate and the pre-merge review covered
  every assigned case.** It saves a review only when nothing else merged in between, and it
  loses the second independent look, which is what found the majors.
- **Fold whenever the reviewer role qualifies (HIST-20's proposal).** It contradicts ADR-060 and
  the map's `slice_lifecycle`, which make verification its own gate on the merged tree; a
  qualifying role says who may review, not that one review answers two questions.
