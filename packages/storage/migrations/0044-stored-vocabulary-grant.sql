-- R-C10's follow-up (decision 4, increment 5): the roadmap's standing re-verification grant,
-- `reverificationGrant`, recorded in migration 0042's stored vocabulary catalog (R-B4, decision
-- 15), so the deploy preflight (R-H3) refuses a rollback to a release whose strict roadmap
-- contract would refuse to write a roadmap holding it back.
--
-- A guard rolls the whole migration back unless the catalog gains exactly this row.

CREATE TABLE migration_0044_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

INSERT INTO stored_vocabulary (kind, value, introduced_in_schema) VALUES
  ('roadmap-field', 'reverificationGrant', 44);

INSERT INTO migration_0044_guard (checkpoint, ok)
SELECT 'catalog-rows', CASE WHEN
    (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 44
       AND kind = 'roadmap-field' AND value = 'reverificationGrant') = 1
    AND (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 44) = 1
    AND (SELECT COUNT(*) FROM stored_vocabulary) = 18
  THEN 1 ELSE 0 END;

DROP TABLE migration_0044_guard;
