# ADR-012 — Planning domain and dependency semantics

- **Status:** accepted
- **Date:** 2026-07-24

## Context

CT-03 interprets an untrusted work-breakdown document into a durable work graph.
The interpretation must be pure, deterministic, and honest about what it does
and does not understand. A planning document is a proposal, not authority.

## Decision

### A pure planning package

`@craftingtable/planning` owns bundle validation, YAML parsing, source-schema
validation, normalisation, identifier validation, dependency analysis, cycle
detection, diagnostics, the canonical digest, and draft projection.

It depends on `@craftingtable/domain` and `yaml` only. It must not import
Fastify, React, SQLite, `better-sqlite3`, `node:fs`, `node:path`,
`node:child_process`, agent SDKs, Git, or CraftingTable server or browser
internals. It accepts bytes plus logical metadata and returns data; it never
opens a file.

`node:crypto`'s `createHash` **is** permitted. It is a hashing primitive, not
I/O: it opens no file, spawns no process, and reaches no network. The
alternative — Web Crypto's `subtle.digest` — is asynchronous and would make the
whole analyzer async for no safety gain.

Validation is hand-written rather than Zod-based. The contract permits Zod
"where runtime schema validation is useful", but CT-03 needs field-precise
diagnostic codes (`invalid-work-item-field` with a source path and work-item
ID), and mapping Zod issues onto those codes would add a layer without adding
rigour. `@craftingtable/contracts` remains the sole owner of Zod wire schemas.

### YAML safety

Parsed with the YAML 1.2 `core` schema, no custom tags, `strict`, and
`uniqueKeys`. Any parser error **or warning** is fatal — unresolved and unknown
tags surface as warnings, and a tag we do not understand is exactly the case
where guessing would be unsafe. More than one document is rejected. Alias
expansion is bounded by `maxAliasCount` at materialisation, where an alias bomb
throws.

Parser output is then rebuilt into a provably JSON-serialisable value with depth
bounded to 32, node count to 20 000, `__proto__`/`constructor`/`prototype` keys
rejected, and non-finite numbers and non-JSON scalars rejected. The diagnostic
names the offending source path.

### Supported profile and preservation

`exo-work-breakdown-v1` requires `document` and `pull_requests` at the top level
and `id`, `title`, `depends_on`, `risk`, `primary_areas`, `exit_gate` per item.

Recognition and retention are separate concerns. Every top-level source key is
preserved verbatim in `metadata` and every item key in `sourceFields`,
*including recognised ones*, so future re-projection never needs the parser. An
unknown field is never fatal.

### Identifiers, risk, and normalisation

Source IDs are NFC-normalised and must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`
within 64 characters, and must be unique within a plan version. `sourceId` is
never a database primary key: it is unique only within a version, and reusing
one mutable row across versions would erase the history Planning Studio needs.

Risk normalises into the closed vocabulary `low | medium | high | critical |
unspecified`. **An unmodelled risk word never fails an import**: it becomes
`unspecified` with an `unrecognized-risk` warning, and the raw value survives in
`sourceFields`. A closed column is what makes risk counts indexable and
assertable; failing the import would punish the operator for CraftingTable's
incomplete vocabulary.

### Dependency semantics

`depends_on` produces **required** edges: they must resolve within the same plan
version, must not be self-referential, must be acyclic, and block readiness.

`recommends` produces **recommended** edges: never blocking. An unresolved
recommendation is a warning and the edge is dropped; a resolved one is stored
with `kind = 'recommended'` and is excluded from `requiredDependencyCount` and
from every blocker derivation. A typo in a recommendation must never acquire
blocking authority.

**A repeated required edge is deterministically deduplicated with a
`duplicate-required-dependency` warning.** The contract required Phase A to
choose between rejecting and deduplicating. Deduplication was chosen because a
repeated edge is unambiguous authoring redundancy with no semantic ambiguity,
because it keeps `requiredDependencyCount` equal to the distinct-edge count that
the database unique constraint and the AQ expectations both require, and because
failing an entire import over it would be disproportionate.

Dependencies are never inferred from Markdown prose. Only the work breakdown
defines the graph.

### Cycle detection

Nodes are visited in source order by an iterative depth-first search with an
explicit stack — iterative so a deep plan cannot overflow the stack. Missing and
self edges are diagnosed and then excluded before the search runs, so one import
surfaces every actionable problem at once instead of hiding a cycle behind an
unrelated typo. Each cycle is canonicalised by rotating its lowest-ordinal
member to the front and deduplicated by that spelling, so entering the same
cycle from two nodes yields one diagnostic. Cycles are reported sorted, capped
at 20 with a summary beyond that, in the exact form
`Required dependency cycle: A → B → A`.

### Readiness vocabulary

```text
planning-ready       proposed, and every required predecessor is Completed
dependency-blocked   at least one required predecessor is not Completed
active               admitted
```

Readiness is derived from predecessor completion, not from "has no
predecessors", even though CT-03 has no completion workflow and the two are
currently equivalent. Writing the general form means CT-04's completion workflow
only has to supply the completed set.

The UI says **planning-ready** or **ready for admission**, never a bare "Ready",
because CT-03 owns none of executable readiness or merge readiness.

### Diagnostics

Codes are stable and part of the import response contract. Diagnostics are
ordered by content — severity, code, artifact, work-item ID, path, message —
rather than by discovery order, because persisted diagnostics carry an ordinal
and re-running the same import must not renumber identical findings.

## Consequences

The parser can be property-tested with no database, HTTP stack, or filesystem.
The AQ fixture's 14 items, 24 required edges, single root, and risk distribution
are provable in a pure unit test against the committed expectation file.

Hand-written validation is more code than a Zod schema and must be kept in step
with the profile constants by tests rather than by the type system.

Deduplicating repeated edges means a plan can contain redundancy that CT-03
silently normalises; the warning is the only signal, so it must remain visible
in the UI.

## Alternatives considered

- **Zod for the source profile** — good schemas, weaker diagnostics; would need
  an issue-to-code mapping layer anyway.
- **`js-yaml`** — no alias-count bound, so no billion-laughs protection.
- **Rejecting repeated required edges** — disproportionate, and would make
  `requiredDependencyCount` ambiguous.
- **Failing on an unrecognised risk word** — punishes the operator for a gap in
  CraftingTable's vocabulary and would have blocked plans that are otherwise
  perfectly valid.
- **Recursive cycle detection** — simpler to read, but stack depth becomes an
  input-controlled failure mode.
- **Storing `sourceId` as the primary key** — would collapse versions together
  and destroy plan history.
