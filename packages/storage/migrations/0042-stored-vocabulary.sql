-- R-B4 (decision 15, increment 4): the stored vocabulary a release adds, recorded in a catalog as
-- the audit catalogs record their actions. The deploy preflight (R-H3) checks migrations only, so
-- this row is what makes it refuse a rollback to a release whose strict contracts would refuse to
-- write a cycle holding these values back.
--
-- stored_vocabulary: one append-only row per value a stored record may carry that an earlier
-- schema's release does not know, with the schema that introduced it. Increment 4 adds the stops
-- `controller-error` used to hide (decision 3), as cycle attention codes, and the phase gate's
-- blocker refs (`refs.blockers`), as an attention ref.
--
-- A guard rolls the whole migration back unless the catalog holds exactly these rows and its
-- triggers are in place.

CREATE TABLE migration_0042_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE stored_vocabulary (
    kind                 TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
    value                TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 64),
    introduced_in_schema INTEGER NOT NULL CHECK (introduced_in_schema >= 42),
    PRIMARY KEY (kind, value)
) STRICT;
CREATE TRIGGER stored_vocabulary_no_update BEFORE UPDATE ON stored_vocabulary
BEGIN SELECT RAISE(ABORT, 'The stored vocabulary catalog is append-only'); END;
CREATE TRIGGER stored_vocabulary_no_delete BEFORE DELETE ON stored_vocabulary
BEGIN SELECT RAISE(ABORT, 'The stored vocabulary catalog is append-only'); END;

INSERT INTO stored_vocabulary (kind, value, introduced_in_schema) VALUES
  ('cycle-attention', 'phase-gate', 42),
  ('cycle-attention', 'item-unavailable', 42),
  ('cycle-attention', 'item-not-admitted', 42),
  ('cycle-attention', 'item-completed-unmerged', 42),
  ('cycle-attention', 'predecessors-incomplete', 42),
  ('cycle-attention', 'predecessor-merge-missing', 42),
  ('cycle-attention', 'worktree-state', 42),
  ('cycle-attention', 'resolution-not-ready', 42),
  ('cycle-attention', 'launch-refused', 42),
  ('cycle-attention', 'roadmap-binding-changed', 42),
  ('cycle-attention', 'delegation-authority-lost', 42),
  ('cycle-attention', 'review-capture-failed', 42),
  ('cycle-attention', 'finalization-inactive', 42),
  ('cycle-attention', 'service-unavailable', 42),
  ('attention-ref', 'blockers', 42);

INSERT INTO migration_0042_guard (checkpoint, ok)
SELECT 'catalog-rows', CASE WHEN
    (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 42
       AND kind = 'cycle-attention') = 14
    AND (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 42
       AND kind = 'attention-ref' AND value = 'blockers') = 1
    AND (SELECT COUNT(*) FROM stored_vocabulary) = 15
  THEN 1 ELSE 0 END;

INSERT INTO migration_0042_guard (checkpoint, ok)
SELECT 'triggers', CASE WHEN
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (
       'stored_vocabulary_no_update', 'stored_vocabulary_no_delete')) = 2
  THEN 1 ELSE 0 END;

DROP TABLE migration_0042_guard;
