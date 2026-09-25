# ADR-068 — Journal retention: raw lines on failure only, tool-result bodies beside the run

- **Status:** accepted
- **Date:** 2026-09-24
- **Refines:** ADR-020 (raw lines "for diagnostics"), ADR-034 and ADR-039 (run retention)

## Context

The run-event journal was 475 MB of a 547 MB database on 2026-09-23. Of that:

- 280 MB was raw vendor lines kept on every event. The browser never read them, and they
  repeated the normalized payload. For Codex they were a re-serialization, not the vendor line.
- 144 MB was tool-result bodies over 4 KiB, which only the run page displays.

The journal is append-only by trigger (ADR-002), so none of it could be pruned. Every daily
backup copied all of it.

## Decision

- **Raw lines only on failure.** An adapter attaches the bounded raw line only to an event it
  could not represent: an unparseable line, or an unknown message or item. That is always a
  `notice` of category `other`. Normalized events carry their meaning in their payload.
- **Tool-result bodies beside the run.** A result over `TOOL_RESULT_PREVIEW_BYTES` (4 KiB) is
  journaled as a preview plus `body: { digest, bytes }`. The full output is gzipped at
  `<run directory>/tool-results/<sha256>.txt.gz`, written then renamed. The field is
  optional: older events keep their whole output in `content`.
  - The agent is given its run directory, so bodies are untrusted. A body that no longer matches
    its digest reads as absent, and the daemon never writes through a linked directory.
  - A member-access route serves a body as plain text.
- **Retention follows the run.** Bodies expire with the run's scratch retention (ADR-034),
  through the same audited, identity-checked cleanup, and never through a link. Like scratch,
  they also wait until nothing in them has changed for a full retention window. Raw lines on
  failure notices are small and stay.
  - A body is read without following a link, only from a regular file, and only up to 8 MiB
    decompressed (twice the adapters' 4 MiB line limit). Anything else reads as absent. A file
    already at a digest's path that does not hold that output is replaced, not trusted.
- **Compaction is explicit and audited.** `craftingtable db compact-journal` applies the same
  rules to ended runs journaled before this decision. It needs the data-directory lock, so the
  daemon must be stopped, and it is a dry run unless given `--apply`.
  - Each run is rewritten in one transaction with a `storage.journal-compacted` audit record.
  - The rewrite goes through the journal's single rewrite path (`AgentRunEventRepository.compact`).
    That path lifts the `agent_run_events_no_update` trigger for its statements, restores it
    byte-identical, verifies it, and passes every rewritten event through the record guard.
  - Normal writes never lift the trigger. `--vacuum` returns the freed pages to the filesystem.
  - It refuses a database with pending migrations, so a dry run never migrates the file.

## Consequences

- **Measured on a copy of the 2026-09-23 database:**
  - Journal bytes of the 310 ended runs fell from 473 MB to 86 MB. The median run fell from
    1.3 MB to 0.2 MB.
  - The file fell from 547 MB to 137 MB after VACUUM, with 54 MB of compressed bodies in run
    directories.
  - `pnpm db:verify` passes, and the controller replay (`--check` and `--every-run`) reports no
    changed decision.
- **Backups.** Daily backups shrink in proportion. Bodies are run files, so a database snapshot
  no longer contains full tool output. ADR-034 already excludes run directories from snapshots.
- **Expired bodies.** After a body expires, the run page shows its preview and the full-output
  link answers 404.
- **Compacted history.** Runs already past retention when compacted keep their bodies for one
  more retention window (30 days from compaction). After that, those runs keep only the 4 KiB
  preview of each large tool result. Before this decision, the journal kept full output forever.
- **What the controller reads.** It never reads tool-result bodies or raw lines. Handoffs use
  messages and turn results.

## Alternatives considered

- **Replacing the append-only trigger** with one that allows shrinking updates: this would weaken
  the guarantee for every write to allow a rare maintenance action.
- **Copying the journal into a new table without raw:** a journal rebuild, which R-H6 reserves
  for one combined, preservation-tested operation.
- **Moving raw lines to a separate prunable table:** that keeps 280 MB nobody reads.
