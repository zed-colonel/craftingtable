# ADR-069: Map-declared upstream pin transitions

Status: accepted
Date: 2026-09-25

## Context

A consumer develops against a historical upstream until it migrates to that upstream's current
pin. ADR-053 decides the dependency source from the kind of slice: domain slices, and
implementation slices that qualify, get the prepared historical upstream; every other scope gets
the current pins. Once a consumer's migration merges, every tree based on it needs the current
pin, whatever kind of slice it belongs to. The WI-02/domain verification review (run efef4f4e)
was supplied AQ 0.1.2 on a `wi-fabric-2` head that already requires AQ `=0.2.0`, and could not
build (register R-F7).

Two further problems follow from deciding by slice kind. Choosing the source per tree is
all-or-nothing, so a consumer with two upstreams cannot build with one link current and the other
historical. And when a consumer has independent first current-pin slices (EXO-03/integration,
EXO-05/integration and the early-start EXO-18/instance-qualification on the live map), whichever
merges first decides when the consumer moves, so the outcome depends on the order of parallel
work.

The roadmap orders all development, and when each link moves belongs to that ordering. Agents do
not decide it, and CraftingTable does not infer it from what has merged.

## Decision

- **Declaration.** A v0.3 map may carry an optional `upstream_transitions[]` of
  `{consumer, upstream, slice}`: the consumer slice whose merge moves that consumer→upstream link
  from the historical upstream to the current pin. Maps without the field import and digest as
  before.
- **Operator record.** For an adopted definition, the operator can approve an immutable
  transition record carrying the same entries. The record is attributed and reasoned, and the
  runtime view shows it. It applies only to that definition; the next map revision carries the
  declarations itself, so the record is not inherited. The effective set for a definition is its
  map entries plus its records. A link can be declared only once.
- **Checks.** The same checks apply to a map at import and to a record at approval. A declaration
  is refused when:
  - the consumer or upstream is not a repository of the map, or the upstream is not one of the
    consumer's required upstreams;
  - the slice does not belong to a consumer work item, or ADR-053 would give it scoped checks;
  - some other consumer scope that ADR-053 gives the current pins does not require the slice
    through start requirements. Requirements of accepted work items and passed checkpoints are
    followed transitively. So no current-pin work can start before its link moves;
  - the upstream is a planned application that itself consumes another upstream U, the consumer
    also depends on U, and the two links are not declared at the same slice (or the other link
    is not declared at all). The same applies from U's side. A planned upstream's current pin
    carries its own upstreams (WI's pin requires AQ `=0.2.0`), and its historical source carries
    historical ones. So the consumer builds only with both links historical or both current, and
    coupled links move together. An implemented upstream's pin is fixed, and the map declares
    nothing it consumes.
- **Choosing the source per link.** When a run starts, each consumer→upstream link is supplied
  separately (`chooseUpstreamSources`):
  - For a scope that ADR-053 gives the current pins, a declared link gets the current pin. An
    undeclared link stops the run with the typed attention code `upstream-transition-undeclared`.
    Nothing falls back to a guess.
  - For a scoped tree, a declared link gets the current pin once the transition slice's recorded
    merge (including integrated code reused across an amendment) is an ancestor of the tree's
    HEAD. The transition slice's own trees always build against the current pins, since the
    checks require it to be a current-pin slice. Otherwise, and for every undeclared link, the
    tree gets the consumer's prepared historical source, or no package when nothing is prepared.
    The registry is never used as a fallback (ADR-053).
- **A fully moved tree is a current-upstream build.** When every link of a scoped tree is on its
  current pin, nothing historical is left, so the run is held to and reports
  `current-upstream-build`. Local CI receives that mode, the brief asks for a pinned Cargo
  build/test, and acceptance requires one. The run environment record freezes this at launch
  (`verificationMode`), and acceptance can only raise a scope's requirement from it, never
  lower it. A partly moved tree stays `scoped-checks`. (Added 2026-09-25: the WI integration
  workflow checks `CRAFTINGTABLE_VERIFICATION_MODE` to confirm current AQ pins, and a moved
  domain tree first reported `scoped-checks` while building current pins.)
- **Provenance.** The run manifest records each link's source (`current-upstream` or
  `historical-development`), the transition that decided it, and the record's id when one did.
  The brief names the source for each link. A scoped receipt still never satisfies a current-pin
  gate.
- **Receipts are not invalidated.** Approving a record changes no binding, decision digest or
  runtime generation. Every earlier receipt was built on a base that predates the transition's
  merge, or against the current pins, so none depended on the missing declaration.

## Consequences

- WI-02/domain's fresh verification builds against AQ `=0.2.0` once the live definition has a
  wi→aq record at WI-02/integration. WI-03/domain's pre-migration tree keeps historical AQ.
- On the live map, no single slice qualifies for EXO's links. EXO's current-pin work stops with
  `upstream-transition-undeclared` until the next map revision declares them. The cleanest shape
  is one slice that adopts current AQ and WI, and that EXO-03/integration, EXO-05/integration and
  EXO-18/instance-qualification all require.
- A map whose consumers have upstreams must declare every link before any of its current-pin work
  runs. This is a deliberate exception to "existing maps execute unchanged". Without it, a
  consumer's move to the current pins happens silently, at an order-dependent point.
- Re-pinning a current link (a new runtime generation, ADR-058) is unchanged; transitions govern
  only the one-time move off the historical upstream. The Planning Studio will author these
  declarations when it exists.
