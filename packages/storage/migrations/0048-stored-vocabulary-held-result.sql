-- R-C17 part 4, decision 0: a Claude result held while tracked background work ran, journaled at
-- the session's end after messages or tool calls the session made past it, is marked
-- `afterLaterWork: true` on its `turn-completed` run event, so the next run's handoff carries the
-- cut-off record. It is recorded in migration 0042's stored vocabulary catalog (R-B4, decision
-- 15), so the deploy preflight (R-H3) refuses a rollback to a release whose strict run-event
-- contract would refuse to read a journal holding it.
--
-- A guard rolls the whole migration back unless the catalog gains exactly this row.

CREATE TABLE migration_0048_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

INSERT INTO stored_vocabulary (kind, value, introduced_in_schema) VALUES
  ('run-event-field', 'afterLaterWork', 48);

INSERT INTO migration_0048_guard (checkpoint, ok)
SELECT 'catalog-rows', CASE WHEN
    (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 48
       AND kind = 'run-event-field' AND value = 'afterLaterWork') = 1
    AND (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 48) = 1
    AND (SELECT COUNT(*) FROM stored_vocabulary) = 29
  THEN 1 ELSE 0 END;

DROP TABLE migration_0048_guard;
