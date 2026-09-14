# ADR-036: Explicit additional finalization remediation

Status: accepted. Refines ADR-033 and ADR-035 recovery.

## Decision

When a paused finalization has a successful, valid review requiring remediation and has
exhausted its allowance, an owner/editor can authorize 1–20 additional attempts (default
one). The UI presents findings, used and allowed counts, the resulting allowance, and
optional guidance. This replaces plain Resume at that checkpoint. Normal Resume and
text guidance never extend the allowance.

Keep initial settings immutable. Store a cumulative additional allowance on the cycle,
with absent values treated as zero for existing records. All remediation budget gates
use initial plus additional allowance; used counts never reset. The allowance spans the
whole finalization, independently of scheduled improvement rounds. The command starts
remediation on the existing candidate, followed by normal verification and remaining
rounds. Guidance applies to the first newly authorized attempt.

The command validates finalization/cycle versions, current editor authority, idle runs,
review lineage, Git state, completed questions checkpoint and pending merge/conflict
reservations. Recheck after asynchronous Git inspection. Persist the allowance, consumed
attempt, next-run reservation and attributed audit event in one transaction. Stale or
replayed requests cannot add allowance twice. Restart preserves the reservation and counts;
it never replays an agent launch automatically.

An explicit grant opens a fresh bounded stagnation window; subsequent unchanged reviews
still trigger the existing no-progress stop. The complete history and cumulative attempt
counts remain. Grants cannot resolve questions, accept invalid reports, waive findings,
change completion thresholds, skip independent final review, or authorize promotion.

## Consequences

Operators can continue useful remediation without restarting finalization or discarding
polish. No database migration is needed for the additive JSON state. This command recovers
exhausted remediation requested by a valid review; incomplete outcomes and owned Git
conflicts retain their separate recovery controls.
