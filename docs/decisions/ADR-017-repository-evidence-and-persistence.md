# ADR-017 — Repository evidence and persistence

- **Status:** accepted
- **Date:** 2026-07-28

## Context

CT-04A1 produces bounded, runtime-validated repository observations but owns no
durable identity or lifecycle. CT-04A2 needs persistent registration,
inspection history, environmental-baseline decisions, and project binding
without giving the domain or storage layers Git, server, or browser authority.

## Decision

Schema 3 uses exactly three strict tables: registered repositories, immutable
repository inspections, and project-repository bindings. Domain owns copied,
closed A1 vocabulary and a pure status reducer; A2b will prove adapter parity
against A1 without making domain depend on Git.

Stored failures distinguish the A1-owned taxonomy from one disjoint A2a
storage-integrity tuple for exact-byte digest mismatch. Error evidence is
normalized deterministically to at most 16 scalar fields and bounded UTF-8
sizes; malformed keys or excess detail are omitted rather than losing the
failure record.

A successful observation is serialized once with `JSON.stringify`. Storage
retains that exact string, the SHA-256 digest of its exact UTF-8 bytes, and
bounded projections. Whitespace and key order are material. The digest detects
accidental byte corruption; it is neither canonical JSON nor authenticity
against a writer able to change both record and digest.

Inspection sequence is the only history order. Registration inserts its
successful inspection before the repository in one immediate transaction. The
inspection-to-repository foreign key is deferred until outer commit, while both
repository-to-inspection keys are immediate. This permits exactly the valid
circular graph and rejects orphan, sibling, and cross-workspace linkage.

Repositories and bindings cannot be deleted. Exact triggers admit only reviewed
status/version transitions. Non-retired repository identity is reserved
globally. Environmental reaffirmation advances the baseline only atomically
from `identity-evidence-changed` to a fresh latest successful reaffirmation
whose core projections still match registration.

Registration and binding insertion return closed typed collision results.
Foreign-workspace identity collisions carry no repository, workspace, path, or
fingerprint payload. User attribution has both a user foreign key and a
workspace-membership composite key. Revoked historical memberships remain
valid attribution; A2b must separately require current role and membership.

Common reader contracts omit Git-directory paths. A distinct administrative
identity contract carries them for a future Owner-authorized A2b endpoint.
Neither repository nor binding `active` is readiness terminology.

## Consequences

The durable model can be tested through direct SQL and used later in one outer
transaction with audit/events. It adds no Git import, child process, Fastify
composition, route, workspace event, notifier, React, or browser code.

An active binding remains historical when repository status becomes non-active;
project projections must join current repository status and reason. Retiring a
repository first retires all active bindings in the same transaction.

Repository and binding controller versions start at one and every admitted
transition increments by exactly one. Equal status timestamps are permitted,
but backwards time, bare bumps, reverse transitions, and delete are rejected.

The three-table design cannot prove that every direct-SQL reaffirmation was
accepted; projections therefore derive acceptance from the repository's
current baseline link rather than from inspection kind.

## Alternatives considered

- Import A1 types directly into domain or storage — rejected because it reverses
  the authority boundary.
- Store only projections — rejected because later comparison needs the full
  versioned record.
- Claim canonical JSON or database authenticity — rejected because neither is
  provided.
- Add audit/events, routes, or Git composition now — deferred to CT-04A2b.
