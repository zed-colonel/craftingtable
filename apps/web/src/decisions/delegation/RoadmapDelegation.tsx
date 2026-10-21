import { About } from '../../components/About.js';
import { ActionBar } from '../../components/ActionBar.js';
import { useState } from 'react';
import type { CrossProjectView, ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  DEFAULT_ROADMAP_AUTOMATION,
  type Roadmap,
  type RoadmapAutomation,
} from '@craftingtable/domain';
import { applyDelegation } from './delegation-api.js';
import { RoadmapAutomationFields } from '../../features/planning/RoadmapAutomationFields.js';
import { ReviewerResponsibilities } from '../../features/planning/ReviewerResponsibilities.js';

/**
 * The operator's grant of future delegation for selected roadmap entries (R-A6 rest, A1): the
 * only poster of `roadmaps/:id/delegation`. A reviewer-assignment stop is resolved here.
 */
export function RoadmapDelegation({
  roadmap,
  view,
  backends,
  csrfToken,
  disabled,
  onChanged,
}: {
  roadmap: Roadmap;
  view: CrossProjectView;
  backends: ExecutionStatusResponse['backends'];
  csrfToken: string;
  disabled: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [filter, setFilter] = useState('');
  const [ids, setIds] = useState<string[]>([]),
    [roles, setRoles] = useState<string[]>([]);
  const [automation, setAutomation] = useState<RoadmapAutomation>(DEFAULT_ROADMAP_AUTOMATION);
  const [reason, setReason] = useState(''),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  // Changed at any status but ended (R-B6, decision 2): the daemon names the selected entries'
  // reviews, refreshes or resolutions still at work, which a grant waits for.
  const locked = disabled || busy || ['stopped', 'completed'].includes(roadmap.status);
  const seed = (next: string[]) => {
    setIds(next);
    setApproved(false);
    const entry = roadmap.definition.entries.find((e) => e.id === next[0]);
    const grant =
      entry && roadmap.delegationAssignments?.findLast((a) => a.entryIds.includes(entry.id));
    setRoles([...(grant?.reviewerRoles ?? entry?.reviewerRoles ?? [])]);
    setAutomation(
      grant?.automation ??
        entry?.automation ??
        roadmap.definition.automation ??
        DEFAULT_ROADMAP_AUTOMATION,
    );
  };
  const apply = async () => {
    setBusy(true);
    setMessage('');
    try {
      await applyDelegation(
        roadmap,
        {
          expectedVersion: roadmap.version,
          entryIds: ids,
          automation,
          reviewerRoles: roles,
          rationale: reason,
        },
        csrfToken,
      );
      setApproved(false);
      setMessage(
        'Delegation saved for future actions; the roadmap’s status and the accepted plan are unchanged.',
      );
      await onChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save delegation.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      id={`future-delegation-${roadmap.id}`}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Delegation for queued and started work</summary>
      {open && (
        <>
          <p>
            Replaces the selected entries’ future delegation, including retries. Refused while a
            selected entry’s review, refresh or conflict resolution is at work.
          </p>
          {['stopped', 'completed'].includes(roadmap.status) && (
            <p className="muted">This roadmap has ended; its delegation no longer changes.</p>
          )}
          <About label="About delegation changes">
            <p>
              This explicit grant replaces integration automation and reviewer responsibilities for
              the selected entries’ future actions, including retries. Existing reports and
              approvals keep their original authority. No new plan-acceptance evidence is needed. A
              refused grant can be applied again once the selected entry’s work finishes.
            </p>
          </About>
          <fieldset disabled={locked}>
            <legend>Select entries</legend>
            <button
              type="button"
              className="secondary-button"
              onClick={() => seed(roadmap.definition.entries.map((e) => e.id))}
            >
              Select all entries
            </button>
            <button type="button" className="secondary-button" onClick={() => seed([])}>
              Clear selection
            </button>
            <details>
              <summary>Choose individual entries · {ids.length} selected</summary>
              <label className="field">
                Filter entries
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="For example, WI-04"
                />
              </label>
              {roadmap.definition.entries
                .filter((e) => e.sourceId.toLowerCase().includes(filter.toLowerCase()))
                .map((e) => (
                  <label key={e.id} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={ids.includes(e.id)}
                      onChange={(ev) => {
                        const next = ev.target.checked
                          ? [...ids, e.id]
                          : ids.filter((id) => id !== e.id);
                        if (!ids.length) seed(next);
                        else {
                          setIds(next);
                          setApproved(false);
                        }
                      }}
                    />
                    {e.sourceId} · {e.executionScope?.kind ?? 'work item'}
                    {roadmap.attempts.some((a) => a.entryId === e.id) ? ' · started' : ''}
                  </label>
                ))}
            </details>
          </fieldset>
          <RoadmapAutomationFields
            value={automation}
            onChange={(v) => {
              setAutomation(v);
              setApproved(false);
            }}
            disabled={locked}
            backends={backends}
          />
          <ReviewerResponsibilities
            label="Future reviewer responsibilities"
            roles={view.reviewerRoles}
            selected={roles}
            nodes={view.nodes.filter((n) => n.included)}
            disabled={locked}
            onChange={(v) => {
              setRoles(v);
              setApproved(false);
            }}
          />
          <label className="field">
            Reason for changing delegation
            <textarea
              value={reason}
              disabled={locked}
              onChange={(e) => {
                setReason(e.target.value);
                setApproved(false);
              }}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={approved}
              disabled={locked}
              onChange={(e) => setApproved(e.target.checked)}
            />
            I authorize these future actions for {ids.length} selected entries.
          </label>
          <ActionBar label="Future delegation authorization">
            <button
              type="button"
              className="primary-button"
              disabled={locked || !approved || !ids.length || !reason.trim()}
              onClick={() => void apply()}
            >
              Apply future delegation
            </button>
          </ActionBar>
          {message && <p role="status">{message}</p>}
          {!!roadmap.delegationAssignments?.length && (
            <p className="hint">
              Last grant: {roadmap.delegationAssignments.at(-1)?.appliedAt} ·{' '}
              {roadmap.delegationAssignments.at(-1)?.rationale}
            </p>
          )}
        </>
      )}
    </details>
  );
}
