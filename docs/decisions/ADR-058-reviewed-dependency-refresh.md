# ADR-058 — Reviewed dependency refresh and precise evidence reuse

- Status: accepted
- Date: 2026-09-19

A provider integration merge can advance one pin without changing every consumer's inputs.
Generation-wide invalidation forces unrelated parents and workstation approvals through unnecessary
recovery. Refine ADR-047/053 evidence reuse and ADR-054 approval applicability using exact input
comparison, while preserving immutable generation provenance.

Scope evidence compares the exact binding, supplied upstream relationships, commit/tree, repository,
crate mappings/versions and conformance identities for its bound consumer, plus captured environment,
fixture, toolchain and authorization identities. External subjects compare their declared tested
consumers and provider inputs in the named environment; unclassified subjects compare all pins.
Missing identities fail closed. Source freshness, case coverage, repository policy, independent
review and native receipt gates remain in force. A source-only policy/documentation commit is still
a changed pin for its consumers. No heuristic waives its checks.

Native approval covers execution authority: the latest approval must remain approved, with the same
binding, host digest and complete environment inputs. A pin change alone does not grant different
host authority or require another identical host audit. Revocation remains effective. Historical
runs and receipts keep their actual generation, manifest and approval IDs; none are copied/relabelled
as newly tested evidence. Saved-plan acceptance always requires the new generation; finalization
continues to require its exact recorded generation.

The browser offers a read-only provider refresh preview with exact commits, evidence effects and
review actions. Explicit apply requires a rationale and the reviewed snapshot digest. Re-inspection,
version checks and idle/paused guards reject changes since preview. Automatic refresh preserves
saved environment, consumer and crate selections; package-set changes require advanced setup.
Saving creates one immutable generation and queues affected completed independent review attempts
atomically. It does not accept the plan or launch agents. After plan acceptance and Resume, normal
phase gates dispatch a fresh review with the same assignment; integrated implementation is retained.
Existing owning-slice recovery keeps its repair budget and completes re-verification through its
existing state machine. Unfinished reviews retain their questions/findings and recovery controls.
The queue survives restart and never grants protected-promotion authority.
