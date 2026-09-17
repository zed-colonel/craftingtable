# ADR-050 — Generated saved-plan evidence and explicit operator review

- Status: accepted
- Date: 2026-09-17

Support an explicit evidence-generation command for the known `STACK-PLAN-ACCEPTED`
setup contract. The daemon collects facts from validated imports, exact bindings,
adoption, the saved roadmap revision, runtime pins and resource configuration. The
immutable evidence submission has a server-only generated marker and no preclaimed
reviewer. An authenticated operator separately reviews and accepts it with a rationale
as stack-integration-owner. This is independent review of daemon-collected setup facts,
not an exemption for agent implementation, qualification or publication evidence.

Bind the package to a digest of those saved facts. Changed configuration requires a
new generation and review; acceptance rechecks state after asynchronous Git checks.
Generation never adopts decisions, accepts a checkpoint or starts/resumes a roadmap.
Unknown plan obligations stay on the ordinary independent-evidence path. Existing
externally reviewed plan submissions remain valid under their original requirements.

Use existing immutable evidence storage without a schema migration. The generic upload
contract cannot create the generated marker. Audit generation as an evidence submission
and retain the separate attributed decision. Startup explicitly exposes unresolved plan
acceptance. Synchronous read snapshots reduce repeated graph parsing; scheduler snapshots
only defer ineligible candidates, while every positive admission retains fresh checks.
