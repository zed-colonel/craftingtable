-- R-B4 (decision 15, increment 5): the stored vocabulary the gates add, appended to migration
-- 0042's catalog so the deploy preflight (R-H3) refuses a rollback to a release whose strict
-- contracts would refuse to write a roadmap holding these values back: the entry wait
-- `predecessor-merge-missing` (decision 1) and the holds' typed cause, `refs.cause` (decision 3).
--
-- A guard rolls the whole migration back unless the catalog gains exactly these rows.

CREATE TABLE migration_0043_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

INSERT INTO stored_vocabulary (kind, value, introduced_in_schema) VALUES
  ('entry-wait', 'predecessor-merge-missing', 43),
  ('attention-ref', 'cause', 43);

INSERT INTO migration_0043_guard (checkpoint, ok)
SELECT 'catalog-rows', CASE WHEN
    (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 43
       AND ((kind = 'entry-wait' AND value = 'predecessor-merge-missing')
         OR (kind = 'attention-ref' AND value = 'cause'))) = 2
    AND (SELECT COUNT(*) FROM stored_vocabulary WHERE introduced_in_schema = 43) = 2
    AND (SELECT COUNT(*) FROM stored_vocabulary) = 17
  THEN 1 ELSE 0 END;

DROP TABLE migration_0043_guard;
