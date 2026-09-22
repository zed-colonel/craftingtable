# ADR-060: Candidate checkpoint evidence and assigned baseline cases

Status: accepted
Date: 2026-09-20

Contract checkpoints required before a slice merge must be reviewable against that
candidate. Requiring the integration head creates a circular gate. Baseline matrices
also label later cases with capability gates; those labels do not move the cases out
of their explicitly assigned slice-verification obligations.

Preserve baseline cases at their assigned slice and parent. Checkpoint preparation
includes the cases assigned to its candidate and displays other case obligations
separately. Existing checkpoint-specific qualification cases remain mandatory.

An authenticated operator can prepare an immutable technical checkpoint packet from
the latest complete, successful, question-free scoped review and frozen controller
receipts. Preparation records no approval. Explicit acceptance requires the operator
to attest every checkpoint reviewer responsibility and give a rationale after reviewing
the source report, build receipts and checkpoint requirements. The retained agent review
is supporting evidence; the daemon does not invent maintainer identities or infer their
attestation from a mergeable verdict.

Candidate provenance is server-only and binds the worktree, slice, report, build,
source tree, source commit and integration baseline. Before merge it applies only to
that slice's merge transition. After the recorded merge, the integration tree must
equal the reviewed candidate tree. Changed reviews, policies, relevant runtime inputs,
candidate commits or integration invalidate reuse. Browser commands and subsequent
transition commands recheck freshness. Merged-slice verification, parent acceptance
and final promotion remain separate gates.

Generic external evidence remains available. Removing the merge checkpoint, accepting
future cases, relabelling candidate tests as already merged, or launching unnecessary
remediation would hide the problem rather than resolve the source-defined workflow.
