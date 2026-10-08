# ADR-050 — Generated saved-plan evidence and explicit operator review

- Status: accepted, amended 2026-10-08 (R-C6)
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

## Amendment 2026-10-08: bound to its inputs, carried by the operator's own commands (R-C6)

The digest of every saved fact re-opened acceptance on edits the checkpoint does not cover: on
the live record, 13 re-requests came from consumer pin advances, saves that changed only the
revision, a capacity change and other settings. Two rules replace the paragraph on binding and
the sentence "Generation never adopts decisions, accepts a checkpoint or starts/resumes a
roadmap" for one case.

**What re-opens acceptance (FMT-17).** The map's identity and archives; the binding and plan
archives; the adopted scheduling decisions; decisions with staged clauses (ADR-059); each entry's
reviewer roles; the target and selection; the map's resource profiles and locks; and the
implemented-upstream pins (commit, tree, crate mappings and conformance) with the list of
implemented upstreams each consumer takes (operator, 2026-10-08). Nothing else does:
not names, instructions, model profiles, automation, completion or parent-acceptance policy,
roadmap scheduling limits, timestamps or the saved revision, a save that changes nothing,
consumer integration pins (ADR-069 governs those), the runtime generation or its environments,
or host capacities. Environments stay out (operator, 2026-10-08): the package attests no
environment and the decision's input list names none; each slice's own evidence still re-opens
when its environment changes. New packages are `saved-plan-v2`: one artifact per input and an
`inputsDigest`, the SHA-256 of the inputs' canonical JSON (keys sorted at every depth), with
`changedInputs`: for a package generated for review, every input changed since the operator's
last own review; for a carried one, those changed since the acceptance it carries. `saved-plan-v1` records keep their
original rule, so nothing re-opens when this ships; an older release cannot read a v2 record.

**Carry-forward.** A re-generation caused by the operator's own authenticated command, a
roadmap save (including its limits), a dependency refresh or advanced dependency setup
(operator, 2026-10-08), a host capacity save, approving a clause-level decision or an adoption,
is accepted as that operator in the command's transaction. The decision records `carriedFrom`,
the prior decision; it is audited as `evidence.decided` with the prior decision and the changed
inputs, and raises no inbox item, since the checkpoint never stops being accepted. It carries
only an acceptance that held just before the command. The first acceptance for a map and
binding stays the operator's: a new import, an amendment or a new binding never carries, nor
does a change to the map, binding or plan archives. The scheduler never accepts, and the
Generate command still only generates. ADR-033 is unchanged: Start, Resume and promotion stay
the operator's. Architecture decisions, baseline acceptance, releases and technical checkpoints
without delegated roles keep their explicit operator decisions.
