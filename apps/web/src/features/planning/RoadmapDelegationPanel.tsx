import { About } from '../../components/About.js';
import { ActionBar } from '../../components/ActionBar.js';
import { useState } from 'react';
import {
  roadmapViewSchema,
  type CrossProjectView,
  type ExecutionStatusResponse,
} from '@craftingtable/contracts';
import {
  DEFAULT_ROADMAP_AUTOMATION,
  type Roadmap,
  type RoadmapAutomation,
} from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { RoadmapAutomationFields } from './RoadmapAutomationFields.js';
import { ReviewerResponsibilities } from './ReviewerResponsibilities.js';

export function RoadmapDelegationPanel({
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
  const locked =
    disabled || busy || !['draft', 'paused', 'needs-attention'].includes(roadmap.status);
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
      await request(
        `/api/workspaces/${roadmap.workspaceId}/roadmaps/${roadmap.id}/delegation`,
        roadmapViewSchema,
        {
          method: 'POST',
          headers: { 'x-craftingtable-csrf': csrfToken },
          body: JSON.stringify({
            expectedVersion: roadmap.version,
            entryIds: ids,
            automation,
            reviewerRoles: roles,
            rationale: reason,
          }),
        },
      );
      setApproved(false);
      setMessage(
        'Delegation saved for future actions. Scheduling remains paused; the accepted plan is unchanged.',
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
            Pause scheduling and let agents finish. This replaces the selected entries’ future
            delegation, including retries; no new plan-acceptance evidence is needed.
          </p>
          <About label="About delegation changes">
            <p>
              This explicit grant replaces integration automation and reviewer responsibilities for
              the selected entries’ future actions, including retries. Existing reports and
              approvals keep their original authority.
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
