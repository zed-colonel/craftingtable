-- R-C17 part 1: a declared check's own time limit, `timeoutMinutes`, which an adopted check
-- declaration records when the repository's checks file sets it. It is recorded in migration
-- 0042's stored vocabulary catalog (R-B4, decision 15), so the deploy preflight (R-H3) refuses a
-- rollback to a release whose strict declaration contract would refuse to read a declaration
-- holding it back.
--
-- A guard rolls the whole migration back unless the catalog gains exactly this row.

CREATE TABLE migration_0045_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

INSERT INTO stored_vocabulary (kind, value, introduced_in_schema) VALUES
  ('check-declaration-field', 'timeoutMinutes', 45);

INSERT INTO migration_0045_guard (checkpoint, ok)
SELECT 'catalog-rows', CASE WHEN
    (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 45
       AND kind = 'check-declaration-field' AND value = 'timeoutMinutes') = 1
    AND (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 45) = 1
    AND (SELECT COUNT(*) FROM stored_vocabulary) = 19
  THEN 1 ELSE 0 END;

DROP TABLE migration_0045_guard;
