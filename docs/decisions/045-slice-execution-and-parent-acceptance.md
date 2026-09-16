# ADR-045 — Slice execution and parent acceptance

- Status: accepted
- Date: 2026-09-16

Keep work items as the source-plan and dependency identities. A worktree and roadmap
entry may additionally identify a slice by immutable map definition, binding revision
and source slice ID. Absence means the existing whole-item workflow. Parent acceptance
uses a separate review scope on the bound integration snapshot.

Resolve scopes on the daemon against the original map and exact plan binding. Agents
receive the slice scope, exclusions, phase requirements, source references and evidence
obligations. Sibling slices may own separate worktrees/cycles; repeated attempts for the
same scope and mixed whole-item/slice execution remain guarded. Scope identity cannot
be changed on an existing worktree or started roadmap entry.

A slice integration records its merge without completing the parent. Verification and
parent acceptance are distinct, attributable records tied to independent review evidence
and exact scope/code. Parent acceptance requires original predecessors, every required
slice, the original exit gate and assigned evidence. Manual completion cannot bypass a
parent's slice obligations. Acceptance records the integration commit for downstream
ancestry checks; finalization still requires all parents complete.

This increment does not adopt map decisions or implement resource/environment authority.
Unknown or unavailable checkpoint, phase or environment evidence remains a visible blocker
at manual and automated mutation boundaries. The reference v0.3 map remains non-executable
until its required scheduling, adoption and dependency-environment semantics ship. No
import, merge or operator selection implicitly passes a checkpoint.
