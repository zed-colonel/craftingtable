# Claude Code project instructions

`AGENTS.md` is the canonical repository guidance. Read and follow it before making changes.

For this session:

1. Read `work-items/CT-04/CT-04A2b1-accepted-implementation-plan.md` as the
   binding implementation contract.
2. Read the CT-04 parent contract, process protocol, source assessment,
   implementation guidance, adversarial matrices, protected specification,
   proposal, design review, and operator disposition referenced there.
3. Read `docs/ui-principles.md` before designing the interface.
4. Work in two phases: first inspect and propose a concrete file-level plan; then edit only after the operator approves that plan.
5. CT-04A2b1 permits only schema-4 repository journal correlation, strict event
   contracts and storage mapping, bounded browser invalidation, and safe
   activity text. Do not compose Git, add child processes, repository
   configuration, lifecycle commands, production server services or routes,
   notifier producers, repository fetches or views, worktrees, or B2 behavior.
6. Keep the implementation small enough that a different coding agent can understand it entirely from committed repository artifacts.
