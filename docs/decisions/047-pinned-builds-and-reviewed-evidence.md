# ADR-047 — Pinned builds and reviewed evidence

- Status: accepted
- Date: 2026-09-16

Keep immutable runtime generations separate from imported definitions and plan bindings.
A generation names exact dependency commits, crate mappings, conformance identities and
local or externally operated qualification environments. Updating the active generation
invalidates reuse of earlier evidence and requires fresh review before integration; it
never rewrites historical runs or receipts or silently advances a dependency branch.

The first build adapter is Cargo. Materialize bounded, ordinary files directly from the
pinned Git objects into each run's private directory, with no shared mutable checkout.
A controller-supplied Cargo launcher injects crate patches, checks the resolved dependency
graph for mismatched sources/versions, and records execution provenance. Incompatible
consumer constraints fail visibly rather than using older registry crates. The adapter
coordinates cooperative builds under the existing OS-user trust model; it is not a sandbox.
(2026-09-28, R-G4: build commands are run by the daemon in a confined unit, with the check time
limit, and their receipts are recorded in its database; the launcher only relays them.)

An integration run may also execute independent crates through the same launcher. Successful
commands whose resolved graph uses none of the configured upstream packages record a
`supplementary-check` receipt. Source/config integrity and wrong-source checks still apply.
These receipts preserve useful domain/contract checks without satisfying the pinned integration
build requirement; a successful build that actually resolves the supplied upstream is still required.

Evidence submissions are immutable, bounded artifact packages, scoped to a definition,
binding, runtime generation, tested commits, environment/fixture/toolchain identities,
requirements and source-case hashes. Checkpoint ownership does not identify its tested code:
consumer compatibility gates also bind each assigned consumer repository commit. A separate authenticated operator decision accepts
or rejects independently reviewed evidence. Missing, failed, duplicate, wrong-scope or
stale proofs cannot satisfy gates. Imported prerequisite eligibility, source hashes,
implementer claims and named resources never supply a pass. AQ baseline acceptance,
consumer compatibility and publication remain different subjects.

Native and actual Kata environments have different typed identities and explicit operator
authorization. This increment records externally performed qualification and its independent
review; it does not provision hosts or dispatch agents onto an unenforced remote boundary.
Local development agents cannot acquire native/Kata launch authority by selecting a label.
External qualified verification can satisfy evidence obligations without claiming that it ran
inside CraftingTable. Decision adoption and integrated target supervision remain increment 5.

Cargo's [configuration precedence](https://doc.rust-lang.org/cargo/reference/config.html) and
[patch semantics](https://doc.rust-lang.org/cargo/reference/overriding-dependencies.html)
require checking the [resolved metadata graph](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html):
patches alone do not guarantee that version constraints selected the supplied crate.

Evidence and native approval applicability across dependency generations are refined by
[ADR-058](ADR-058-reviewed-dependency-refresh.md); original run/receipt provenance remains immutable.
