-- R-B4b (R-B4 decisions 5 to 8 and 11): the cycle's state shape, and codes for every record written
-- before them, so the controller reads no text the daemon wrote.
--
-- Every cycle's `state_json` is rewritten, every combination stored mapping one to one:
--   * `stop`: the stop a `needs-attention` or `awaiting-merge` cycle is at, or the one a pause was
--     taken at, as `{ kind: 'attention' | 'gate', ...attention, since }` (a gate exactly when its
--     code is one of the merge boundary's six); a stopped or completed cycle's end as
--     `{ kind: 'ended', code, at }`. A stop's `since` and an end's `at` are when the audit trail
--     says the cycle entered that status (a kept stop: its `needs-attention`), else `updatedAt`.
--     A stopped cycle's end code is the audit action that entered `stopped` (`stop`,
--     `roadmap-wound-down`, `amendment-retired`); a completed one's is `scope-evidence-recorded`
--     when its review's scope receipt is recorded, as the `integrated` guard decides, else
--     `integrated`.
--   * `waits`: `phaseWait` and `designWait` as `waits.phase` and `waits.design`, their `startedAt`
--     as `since` (`null` and absent both meaning no wait); each phase blocker stored without a code
--     takes the one `phaseBlockerCode` recovers, and a resource blocker without its key the one
--     `phaseBlockerResourceKey` reads.
--   * `attempt`: `stepGuidance`, `housekeepingInstructions`, `resultContinuations`, `outputRepair`
--     and `providerRecovery`, each moved with the value it holds (`''`, `0` and `null` included).
--   * `retiredFinalization`: `polishRound` and `deferredNits`.
-- A stop stored without a code takes the one `effectiveCycleAttention` recovers; a roadmap's
-- stop and an entry's hold stored without one, `effectiveRoadmapAttention`'s and
-- `effectiveHoldAttention`'s. The audit trail is never rewritten: R-C1's measure decodes it.
--
-- A guard rolls the whole migration back unless every count below holds, and if a stopped cycle
-- entered `stopped` by an action this mapping does not know (none in the replay corpus): a code is
-- never invented. `pnpm db:verify` on a copy shows it before a deploy.

CREATE TABLE migration_0047_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

-- What the guard compares after the rewrite.
CREATE TEMP TABLE m0047_before AS SELECT
  (SELECT COUNT(*) FROM work_cycles) AS cycles,
  (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.phaseWait') = 'object') AS phase,
  (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.designWait') = 'object') AS design,
  (SELECT COUNT(*) FROM work_cycles WHERE
     json_type(state_json, '$.stepGuidance') IS NOT NULL
     OR json_type(state_json, '$.housekeepingInstructions') IS NOT NULL
     OR json_type(state_json, '$.resultContinuations') IS NOT NULL
     OR json_type(state_json, '$.outputRepair') IS NOT NULL
     OR json_type(state_json, '$.providerRecovery') IS NOT NULL) AS attempts,
  (SELECT COUNT(*) FROM work_cycles WHERE
     json_type(state_json, '$.polishRound') IS NOT NULL
     OR json_type(state_json, '$.deferredNits') IS NOT NULL) AS retired,
  -- Each moved field, so a value dropped on the way (`''`, `0` and `null` included) fails.
  (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.stepGuidance') IS NOT NULL)
    AS step_guidance,
  (SELECT COUNT(*) FROM work_cycles
     WHERE json_type(state_json, '$.housekeepingInstructions') IS NOT NULL) AS housekeeping,
  (SELECT COUNT(*) FROM work_cycles
     WHERE json_type(state_json, '$.resultContinuations') IS NOT NULL) AS continuations,
  (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.outputRepair') IS NOT NULL)
    AS output_repair,
  (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.providerRecovery') IS NOT NULL)
    AS provider_recovery,
  (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.polishRound') IS NOT NULL)
    AS polish_round,
  (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.deferredNits') IS NOT NULL)
    AS deferred_nits,
  -- The stops a pause kept.
  (SELECT COUNT(*) FROM work_cycles WHERE status = 'paused'
     AND json_type(state_json, '$.attention') IS NOT NULL) AS kept,
  (SELECT COUNT(*) FROM work_cycles, json_each(work_cycles.state_json, '$.phaseWait.blockers'))
    AS blockers,
  (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.attention') IS NOT NULL
     AND status IN ('running', 'stopped', 'completed')) AS stray,
  (SELECT COUNT(*) FROM roadmaps) AS roadmaps;

-- Each stored stop's code, which the rewrite must keep.
CREATE TEMP TABLE m0047_codes AS
SELECT id, state_json ->> '$.attention.code' AS code FROM work_cycles
WHERE status IN ('needs-attention', 'awaiting-merge', 'paused')
  AND state_json ->> '$.attention.code' IS NOT NULL;

-- The audit rows that changed each cycle's status, the insert's included.
CREATE TEMP TABLE m0047_entered AS
SELECT cycle_id, sequence, occurred_at, status, action FROM (
  SELECT target_id AS cycle_id, sequence, occurred_at,
         json_extract(metadata_json, '$.status') AS status,
         json_extract(metadata_json, '$.action') AS action,
         LAG(json_extract(metadata_json, '$.status'))
           OVER (PARTITION BY target_id ORDER BY sequence) AS previous
  FROM audit_events
  WHERE action = 'work-cycle.updated' AND target_type = 'work-cycle')
WHERE previous IS NULL OR previous <> status;
CREATE INDEX temp.m0047_entered_cycle ON m0047_entered (cycle_id, status, sequence);

-- Each cycle's parts in the new shape, as JSON text (NULL where it has none).
CREATE TEMP TABLE m0047_parts AS
WITH cycles AS (
  SELECT id, status, state_json AS s,
    -- A stop stored without a code takes the code the decoder recovers.
    CASE
      WHEN json_type(state_json, '$.attention') IS NOT NULL THEN state_json ->> '$.attention.code'
      WHEN status = 'awaiting-merge' THEN CASE
        WHEN json_type(state_json, '$.workflow.waiting') = 'text'
          AND state_json ->> '$.workflow.waiting' <> '' THEN 'controller-wait'
        WHEN substr(state_json ->> '$.reason', 1, 62)
          = 'Technical review finished. Further controller reviews are held' THEN 'scheduling-held'
        WHEN json_type(state_json, '$.executionScope') = 'object'
          AND state_json ->> '$.executionScope.kind' <> 'slice' THEN 'record-scope-evidence'
        WHEN json_type(state_json, '$.finalizationId') = 'text' THEN 'final-promotion'
        ELSE 'merge-approval' END
      WHEN status = 'needs-attention' THEN CASE
        WHEN substr(state_json ->> '$.reason', 1, 17) = 'Daemon restarted.' THEN 'restart-resume'
        WHEN substr(state_json ->> '$.reason', 1, 51)
          = 'Remediation limit reached. Review needs your input.'
          THEN 'review-open-questions-at-limit'
        WHEN substr(state_json ->> '$.reason', 1, 26) = 'Remediation limit reached.'
          THEN 'remediation-exhausted'
        WHEN substr(state_json ->> '$.reason', 1, 22) = 'Two remediation rounds'
          THEN 'remediation-stalled'
        WHEN substr(state_json ->> '$.reason', 1, 32) = 'Implementation needs your input.'
          THEN 'implementation-open-questions'
        WHEN substr(state_json ->> '$.reason', 1, 24) = 'Review needs your input.'
          THEN 'review-open-questions'
        WHEN substr(state_json ->> '$.reason', 1, 33) = 'Workflow report needs correction.'
          THEN 'workflow-report-invalid'
        WHEN substr(state_json ->> '$.reason', 1, 44) = 'Workflow report and Open questions disagree.'
          THEN 'workflow-questions-disagree'
        WHEN substr(state_json ->> '$.reason', 1, 27) = 'Operator decision required.'
          THEN 'shared-decision-required'
        WHEN substr(state_json ->> '$.reason', 1, 24) = 'Operator input required.'
          THEN 'work-item-questions'
        WHEN substr(state_json ->> '$.reason', 1, 29) = 'Finalization needs your input'
          THEN 'finalization-needs-input'
        WHEN substr(state_json ->> '$.reason', 1, 25) = 'Design has open questions'
          THEN 'design-open-questions'
        WHEN substr(state_json ->> '$.reason', 1, 34) = 'Design needs an operator decision.'
          THEN 'design-decision-required'
        WHEN substr(state_json ->> '$.reason', 1, 38) = 'Design identified a planning conflict.'
          THEN 'design-planning-conflict'
        WHEN substr(state_json ->> '$.reason', 1, 30) = 'Design investigation finished.'
          THEN 'design-investigation-finished'
        WHEN substr(state_json ->> '$.reason', 1, 31) = 'Scope review requires recovery:'
          THEN 'scope-review-recovery'
        WHEN substr(state_json ->> '$.reason', 1, 31) = 'Scope review has open questions'
          THEN 'scope-review-open-questions'
        WHEN substr(state_json ->> '$.reason', 1, 58)
          = 'The step did not finish with a complete successful result.' THEN 'step-incomplete'
        WHEN substr(state_json ->> '$.reason', 1, 24) = 'Step time limit reached.'
          THEN 'step-time-limit'
        WHEN substr(state_json ->> '$.reason', 1, 34) = 'Integration refresh limit reached.'
          THEN 'integration-refresh-limit'
        ELSE 'legacy-attention' END
    END AS code,
    -- When the stop began: the cycle's entry into its status, a kept stop's into its own.
    coalesce(
      (SELECT e.occurred_at FROM m0047_entered e WHERE e.cycle_id = work_cycles.id
         AND e.status = CASE WHEN work_cycles.status = 'paused' THEN 'needs-attention'
                             ELSE work_cycles.status END
       ORDER BY e.sequence DESC LIMIT 1),
      state_json ->> '$.updatedAt') AS since,
    -- How an ended cycle ended.
    CASE
      WHEN status = 'stopped' THEN (
        SELECT CASE e.action
                 WHEN 'stop' THEN 'operator-stopped'
                 WHEN 'roadmap-wound-down' THEN 'roadmap-wound-down'
                 WHEN 'amendment-retired' THEN 'amendment-retired' END
        -- The row that entered `stopped`, which `at` reads too (it is terminal: there is one).
        FROM m0047_entered e WHERE e.cycle_id = work_cycles.id AND e.status = 'stopped'
        ORDER BY e.sequence DESC LIMIT 1)
      WHEN status = 'completed' THEN CASE
        WHEN json_type(state_json, '$.executionScope') = 'object'
          AND state_json ->> '$.executionScope.kind' <> 'slice'
          AND json_type(state_json, '$.workItemId') = 'text'
          AND EXISTS (SELECT 1 FROM scope_receipts r
            WHERE r.workspace_id = work_cycles.workspace_id
              AND r.work_item_id = work_cycles.work_item_id
              AND r.worktree_id = work_cycles.worktree_id
              AND r.review_run_id = state_json ->> '$.currentRunId')
          THEN 'scope-evidence-recorded'
        ELSE 'integrated' END
    END AS end_code
  FROM work_cycles
),
attentions AS (
  SELECT id,
    CASE WHEN json_type(s, '$.attention') IS NOT NULL THEN json(s -> '$.attention')
         ELSE json_object('code', code, 'owner',
           CASE WHEN code IN ('controller-wait', 'scheduling-held') THEN 'controller'
                ELSE 'operator' END) END AS attention
  FROM cycles
  WHERE code IS NOT NULL AND (status IN ('needs-attention', 'awaiting-merge')
    OR (status = 'paused' AND json_type(s, '$.attention') IS NOT NULL))
),
blockers AS (
  SELECT c.id, b.key AS position,
    json_set(b.value,
      '$.code', coalesce(b.value ->> '$.code', CASE
        WHEN b.value ->> '$.kind' = 'authorization'
          AND substr(b.value ->> '$.message', 1, 36) = 'Resource controlled-native-test-host'
          THEN 'environment-approval'
        WHEN b.value ->> '$.kind' = 'authorization'
          AND substr(b.value ->> '$.message', 1, 9) = 'Resource ' THEN 'resource-unsupported'
        WHEN b.value ->> '$.kind' = 'evidence'
          AND substr(b.value ->> '$.message', 1, 11) = 'Checkpoint ' THEN 'checkpoint-evidence'
        WHEN b.value ->> '$.kind' = 'evidence'
          AND substr(b.value ->> '$.message', 1, 15) = 'Required slice ' THEN CASE
            WHEN substr(b.value ->> '$.message', -15) = 'has not merged.'
              THEN 'required-slice-unmerged' ELSE 'required-slice-unverified' END
        WHEN b.value ->> '$.kind' = 'evidence' THEN 'staged-approval-prerequisite'
        WHEN b.value ->> '$.kind' = 'dependency' THEN 'slice-requirement'
        WHEN b.value ->> '$.kind' = 'resource' THEN 'resource-busy'
        WHEN b.value ->> '$.kind' = 'review' THEN 'reviewer-assignment'
        ELSE 'legacy-blocker' END)) AS blocker
  FROM cycles c, json_each(c.s, '$.phaseWait.blockers') b
  WHERE json_type(c.s, '$.phaseWait') = 'object'
),
keyed AS (
  -- A resource blocker stored before its key: `^Waiting for (\S+):`, the run of non-space
  -- characters after the prefix, up to its last colon. The daemon wrote these messages with an
  -- ASCII space after the key, so the split on ' ' is the regex's on every stored message.
  SELECT id, position, blocker,
    CASE WHEN blocker ->> '$.code' = 'resource-busy'
           AND json_type(blocker, '$.refs.resourceKey') IS NULL
           AND substr(blocker ->> '$.message', 1, 12) = 'Waiting for '
      THEN substr(blocker ->> '$.message', 13,
             CASE instr(substr(blocker ->> '$.message', 13), ' ')
               WHEN 0 THEN length(blocker ->> '$.message')
               ELSE instr(substr(blocker ->> '$.message', 13), ' ') - 1 END)
    END AS token
  FROM blockers
),
phase AS (
  SELECT id, json_group_array(json(CASE
      WHEN token IS NOT NULL
        AND length(rtrim(token, replace(token, ':', ''))) > 1
        THEN json_set(blocker, '$.refs.resourceKey',
          substr(rtrim(token, replace(token, ':', '')), 1,
                 length(rtrim(token, replace(token, ':', ''))) - 1))
      ELSE blocker END) ORDER BY position) AS blockers
  FROM keyed
  GROUP BY id
)
SELECT c.id,
  CASE
    WHEN c.status IN ('stopped', 'completed') THEN
      CASE WHEN c.end_code IS NULL THEN NULL
           ELSE json_object('kind', 'ended', 'code', c.end_code, 'at',
             coalesce((SELECT e.occurred_at FROM m0047_entered e WHERE e.cycle_id = c.id
                         AND e.status = c.status ORDER BY e.sequence DESC LIMIT 1),
                      c.s ->> '$.updatedAt')) END
    -- `json_patch` would drop a null member, which the contract never let a stop hold; the
    -- `stop-codes` and `stops` checkpoints hold the code and `since` it must keep.
    WHEN a.attention IS NOT NULL THEN json_patch(
      json_object('kind', CASE WHEN a.attention ->> '$.code' IN ('merge-approval',
          'merge-requirements', 'final-promotion', 'record-scope-evidence', 'controller-wait',
          'scheduling-held') THEN 'gate' ELSE 'attention' END),
      json_set(a.attention, '$.since', c.since))
  END AS stop,
  CASE WHEN json_type(c.s, '$.phaseWait') = 'object' OR json_type(c.s, '$.designWait') = 'object'
    THEN json_remove(
      json_object(
        'phase', CASE WHEN json_type(c.s, '$.phaseWait') = 'object' THEN json_object(
          'since', c.s ->> '$.phaseWait.startedAt',
          'blockers', json(coalesce(p.blockers, '[]'))) END,
        'design', CASE WHEN json_type(c.s, '$.designWait') = 'object' THEN json_object(
          'since', c.s ->> '$.designWait.startedAt',
          'requirements', json(c.s -> '$.designWait.requirements')) END),
      CASE WHEN json_type(c.s, '$.phaseWait') = 'object' THEN '$.none' ELSE '$.phase' END,
      CASE WHEN json_type(c.s, '$.designWait') = 'object' THEN '$.none' ELSE '$.design' END)
  END AS waits,
  (SELECT json_group_object(f.column1, json(c.s -> ('$.' || f.column1)))
   FROM (VALUES ('stepGuidance'), ('housekeepingInstructions'), ('resultContinuations'),
                ('outputRepair'), ('providerRecovery')) f
   WHERE json_type(c.s, '$.' || f.column1) IS NOT NULL
   HAVING COUNT(*) > 0) AS attempt,
  (SELECT json_group_object(f.column1, json(c.s -> ('$.' || f.column1)))
   FROM (VALUES ('polishRound'), ('deferredNits')) f
   WHERE json_type(c.s, '$.' || f.column1) IS NOT NULL
   HAVING COUNT(*) > 0) AS retired,
  (c.status = 'stopped' AND c.end_code IS NULL) AS unmapped
FROM cycles c
LEFT JOIN attentions a ON a.id = c.id
LEFT JOIN phase p ON p.id = c.id;

-- A stopped cycle whose end this mapping does not know fails the migration (see above). The
-- `stops` checkpoint would refuse it too; this one names the case.
INSERT INTO migration_0047_guard (checkpoint, ok)
SELECT 'every-end-known', CASE WHEN (SELECT COUNT(*) FROM m0047_parts WHERE unmapped) = 0
  THEN 1 ELSE 0 END;
-- No running or ended cycle carried a stop: the writer has cleared one since codes (R-A3).
INSERT INTO migration_0047_guard (checkpoint, ok)
SELECT 'no-stray-stop', CASE WHEN (SELECT stray FROM m0047_before) = 0 THEN 1 ELSE 0 END;

UPDATE work_cycles SET state_json = (
  SELECT json_remove(
    json_set(json_remove(work_cycles.state_json,
        '$.attention', '$.phaseWait', '$.designWait', '$.stepGuidance',
        '$.housekeepingInstructions', '$.resultContinuations', '$.outputRepair',
        '$.providerRecovery', '$.polishRound', '$.deferredNits'),
      '$.stop', json(p.stop), '$.waits', json(p.waits), '$.attempt', json(p.attempt),
      '$.retiredFinalization', json(p.retired)),
    CASE WHEN p.stop IS NULL THEN '$.stop' ELSE '$.none' END,
    CASE WHEN p.waits IS NULL THEN '$.waits' ELSE '$.none' END,
    CASE WHEN p.attempt IS NULL THEN '$.attempt' ELSE '$.none' END,
    CASE WHEN p.retired IS NULL THEN '$.retiredFinalization' ELSE '$.none' END)
  FROM m0047_parts p WHERE p.id = work_cycles.id);

-- A roadmap's stop and its entries' holds stored without a code.
UPDATE roadmaps SET state_json = json_set(state_json, '$.attention', json_object(
    'code', CASE WHEN substr(state_json ->> '$.reason', 1, 17) = 'Daemon restarted.'
              THEN 'restart-resume' ELSE 'legacy-attention' END,
    'owner', 'operator'))
WHERE status = 'needs-attention' AND json_type(state_json, '$.attention') IS NULL;
UPDATE roadmaps SET state_json = json_set(state_json, '$.entryHolds', (
    SELECT json_group_object(h.key, json(CASE
        WHEN h.value ->> '$.status' = 'needs-attention' AND json_type(h.value, '$.attention') IS NULL
          THEN json_set(h.value, '$.attention',
            json_object('code', 'legacy-attention', 'owner', 'operator'))
        ELSE h.value END))
    FROM json_each(roadmaps.state_json, '$.entryHolds') h))
WHERE EXISTS (SELECT 1 FROM json_each(roadmaps.state_json, '$.entryHolds') h
  WHERE h.value ->> '$.status' = 'needs-attention' AND json_type(h.value, '$.attention') IS NULL);

INSERT INTO migration_0047_guard (checkpoint, ok)
SELECT 'cycles', CASE WHEN
    (SELECT COUNT(*) FROM work_cycles) = (SELECT cycles FROM m0047_before)
    AND NOT EXISTS (SELECT 1 FROM work_cycles WHERE
         json_type(state_json, '$.attention') IS NOT NULL
      OR json_type(state_json, '$.phaseWait') IS NOT NULL
      OR json_type(state_json, '$.designWait') IS NOT NULL
      OR json_type(state_json, '$.stepGuidance') IS NOT NULL
      OR json_type(state_json, '$.housekeepingInstructions') IS NOT NULL
      OR json_type(state_json, '$.resultContinuations') IS NOT NULL
      OR json_type(state_json, '$.outputRepair') IS NOT NULL
      OR json_type(state_json, '$.providerRecovery') IS NOT NULL
      OR json_type(state_json, '$.polishRound') IS NOT NULL
      OR json_type(state_json, '$.deferredNits') IS NOT NULL)
  THEN 1 ELSE 0 END;

INSERT INTO migration_0047_guard (checkpoint, ok)
SELECT 'stops', CASE WHEN NOT EXISTS (SELECT 1 FROM work_cycles WHERE CASE status
      WHEN 'needs-attention' THEN state_json ->> '$.stop.kind' IS NOT 'attention'
        OR state_json ->> '$.stop.code' IS NULL OR json_type(state_json, '$.stop.since') IS NOT 'text'
      WHEN 'awaiting-merge' THEN state_json ->> '$.stop.kind' IS NOT 'gate'
        OR state_json ->> '$.stop.code' IS NULL OR json_type(state_json, '$.stop.since') IS NOT 'text'
      WHEN 'paused' THEN json_type(state_json, '$.stop') IS NOT NULL
        AND (state_json ->> '$.stop.kind' IS NOT 'attention'
          OR state_json ->> '$.stop.code' IS NULL
          OR json_type(state_json, '$.stop.since') IS NOT 'text')
      WHEN 'running' THEN json_type(state_json, '$.stop') IS NOT NULL
      ELSE state_json ->> '$.stop.kind' IS NOT 'ended' OR state_json ->> '$.stop.code' IS NULL
        OR state_json ->> '$.stop.at' IS NULL END)
  THEN 1 ELSE 0 END;

-- Every stored code kept, and every stop a pause kept still held.
INSERT INTO migration_0047_guard (checkpoint, ok)
SELECT 'stop-codes', CASE WHEN
    NOT EXISTS (SELECT 1 FROM m0047_codes c JOIN work_cycles w ON w.id = c.id
      WHERE w.state_json ->> '$.stop.code' IS NOT c.code)
    AND (SELECT COUNT(*) FROM work_cycles WHERE status = 'paused'
         AND json_type(state_json, '$.stop') IS NOT NULL) = (SELECT kept FROM m0047_before)
  THEN 1 ELSE 0 END;

INSERT INTO migration_0047_guard (checkpoint, ok)
SELECT 'waits-attempts-retired', CASE WHEN
    (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.waits.phase') = 'object')
      = (SELECT phase FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.waits.design') = 'object')
      = (SELECT design FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles WHERE json_type(state_json, '$.attempt') = 'object')
      = (SELECT attempts FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles
         WHERE json_type(state_json, '$.retiredFinalization') = 'object')
      = (SELECT retired FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles
         WHERE json_type(state_json, '$.attempt.stepGuidance') IS NOT NULL)
      = (SELECT step_guidance FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles
         WHERE json_type(state_json, '$.attempt.housekeepingInstructions') IS NOT NULL)
      = (SELECT housekeeping FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles
         WHERE json_type(state_json, '$.attempt.resultContinuations') IS NOT NULL)
      = (SELECT continuations FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles
         WHERE json_type(state_json, '$.attempt.outputRepair') IS NOT NULL)
      = (SELECT output_repair FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles
         WHERE json_type(state_json, '$.attempt.providerRecovery') IS NOT NULL)
      = (SELECT provider_recovery FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles
         WHERE json_type(state_json, '$.retiredFinalization.polishRound') IS NOT NULL)
      = (SELECT polish_round FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles
         WHERE json_type(state_json, '$.retiredFinalization.deferredNits') IS NOT NULL)
      = (SELECT deferred_nits FROM m0047_before)
    AND (SELECT COUNT(*) FROM work_cycles, json_each(work_cycles.state_json, '$.waits.phase.blockers'))
      = (SELECT blockers FROM m0047_before)
    AND NOT EXISTS (SELECT 1 FROM work_cycles, json_each(work_cycles.state_json, '$.waits.phase.blockers') b
      WHERE json_type(b.value, '$.code') IS NULL)
  THEN 1 ELSE 0 END;

INSERT INTO migration_0047_guard (checkpoint, ok)
SELECT 'roadmaps', CASE WHEN
    (SELECT COUNT(*) FROM roadmaps) = (SELECT roadmaps FROM m0047_before)
    AND NOT EXISTS (SELECT 1 FROM roadmaps WHERE status = 'needs-attention'
      AND json_type(state_json, '$.attention') IS NULL)
    AND NOT EXISTS (SELECT 1 FROM roadmaps, json_each(roadmaps.state_json, '$.entryHolds') h
      WHERE h.value ->> '$.status' = 'needs-attention' AND json_type(h.value, '$.attention') IS NULL)
  THEN 1 ELSE 0 END;

-- The new stored vocabulary, so a rollback across it is refused by the catalog as well (R-B4
-- decision 15): four cycle fields and five end codes an earlier release cannot store.
INSERT INTO stored_vocabulary (kind, value, introduced_in_schema) VALUES
  ('cycle-field', 'stop', 47),
  ('cycle-field', 'waits', 47),
  ('cycle-field', 'attempt', 47),
  ('cycle-field', 'retiredFinalization', 47),
  ('cycle-end', 'operator-stopped', 47),
  ('cycle-end', 'roadmap-wound-down', 47),
  ('cycle-end', 'amendment-retired', 47),
  ('cycle-end', 'integrated', 47),
  ('cycle-end', 'scope-evidence-recorded', 47);

DROP TABLE m0047_codes;
DROP TABLE m0047_parts;
DROP TABLE m0047_entered;
DROP TABLE m0047_before;
DROP TABLE migration_0047_guard;
