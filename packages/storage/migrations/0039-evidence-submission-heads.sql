-- R-H4 (operator decision 2026-10-06, P3 design pass): a head table beside the evidence records.
-- Each submission's head is its record with every artifact's contents replaced by
-- {name, digest, bytes, blank}: the contents' size in UTF-8 bytes, and whether they are empty or
-- only whitespace as JavaScript's trim() sees it. The views, the decision inbox and the policies
-- read heads; only a submission's own review and db:verify read the record. The records are not
-- changed. A head is written with its record in one transaction and is immutable like it.

CREATE TABLE migration_0039_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE evidence_submission_heads (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, definition_id TEXT NOT NULL,
 head_json TEXT NOT NULL CHECK(json_valid(head_json)
   AND json_extract(head_json, '$.id') IS id
   AND json_extract(head_json, '$.workspaceId') IS workspace_id
   AND json_extract(head_json, '$.definitionId') IS definition_id),
 FOREIGN KEY(workspace_id,id) REFERENCES evidence_submissions(workspace_id,id)
) STRICT;
CREATE INDEX evidence_submission_heads_by_definition
  ON evidence_submission_heads(workspace_id, definition_id);
CREATE TRIGGER evidence_submission_head_no_update BEFORE UPDATE ON evidence_submission_heads BEGIN SELECT RAISE(ABORT,'Evidence is immutable'); END;
CREATE TRIGGER evidence_submission_head_no_delete BEFORE DELETE ON evidence_submission_heads BEGIN SELECT RAISE(ABORT,'Evidence is immutable'); END;

-- In submission order, so the heads' rowids keep it. The whitespace set is ECMAScript's
-- WhiteSpace and LineTerminator, which String.prototype.trim removes.
INSERT INTO evidence_submission_heads (id, workspace_id, definition_id, head_json)
SELECT s.id, s.workspace_id, json_extract(s.record_json, '$.definitionId'),
  json_set(s.record_json, '$.artifacts', json((
    SELECT json_group_array(json_object(
      'name', json_extract(a.value, '$.name'),
      'digest', json_extract(a.value, '$.digest'),
      'bytes', length(CAST(json_extract(a.value, '$.content') AS BLOB)),
      'blank', json(CASE WHEN trim(json_extract(a.value, '$.content'), char(
          9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200,
          8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = '' THEN 'true' ELSE 'false' END)
    ) ORDER BY a.key)
    FROM json_each(s.record_json, '$.artifacts') AS a)))
FROM evidence_submissions AS s ORDER BY s.rowid;

-- Every submission has exactly one head, in the same order, with one artifact head per artifact
-- and no contents; otherwise the whole migration rolls back.
INSERT INTO migration_0039_guard (checkpoint, ok)
SELECT 'heads', CASE WHEN
    (SELECT COUNT(*) FROM evidence_submission_heads) = (SELECT COUNT(*) FROM evidence_submissions)
    AND NOT EXISTS (
      SELECT 1 FROM evidence_submissions AS s
      LEFT JOIN evidence_submission_heads AS h ON h.id = s.id AND h.workspace_id = s.workspace_id
      WHERE h.id IS NULL
        OR json_array_length(h.head_json, '$.artifacts')
           IS NOT json_array_length(s.record_json, '$.artifacts'))
    AND NOT EXISTS (
      SELECT 1 FROM evidence_submission_heads AS h, json_each(h.head_json, '$.artifacts') AS a
      WHERE json_type(a.value, '$.content') IS NOT NULL)
    AND (SELECT group_concat(id, ',' ORDER BY rowid) FROM evidence_submissions)
      IS (SELECT group_concat(id, ',' ORDER BY rowid) FROM evidence_submission_heads)
  THEN 1 ELSE 0 END;

DROP TABLE migration_0039_guard;
