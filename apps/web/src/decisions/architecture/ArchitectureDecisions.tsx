import { useState } from 'react';
import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { ArchitectureDecision, settles } from './ArchitectureDecision.js';
import { BatchApproval } from './BatchApproval.js';

/**
 * Setup's shared architecture decisions step (R-A6 rest): approval of several saved proposals
 * together (A2 keeps it here), one card per decision the daemon lists, and any other decision
 * of the map, opened by name to prepare or write directly. An item renders one card alone.
 */
export function ArchitectureDecisions({
  workspaceId,
  definitionId,
  view,
  roadmapId,
  csrfToken,
  disabled,
  onChanged,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  view: RuntimeEvidenceView;
  roadmapId?: string | undefined;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
}) {
  const [other, setOther] = useState('');
  const data = view.decisionInbox;
  const decisions = data?.decisions ?? [];
  const listed = new Set(decisions.map((d) => d.checkpointId));
  const unlisted = (view.architectureDecisions?.checkpoints ?? []).filter((c) => !listed.has(c.id));
  if (!decisions.length && !unlisted.length) return null;
  const accepted = (card: (typeof decisions)[number]) =>
    card.records.some((record) => settles(card, record));
  const card = (checkpointId: string) => (
    <ArchitectureDecision
      key={`${definitionId}:${view.bindingRevision}:${checkpointId}`}
      workspaceId={workspaceId}
      definitionId={definitionId}
      view={view}
      checkpointId={checkpointId}
      roadmapId={roadmapId}
      csrfToken={csrfToken}
      disabled={disabled}
      onChanged={onChanged}
    />
  );
  return (
    <Section
      title="Shared architecture decisions"
      summary={`${decisions.filter(accepted).length} of ${decisions.length} decisions have applicable approval.`}
    >
      <About label="About decision approval">
        <p>
          Full approval settles the architectural choice. Implementation, tests and parent
          acceptance keep their own gates. A limited approval settles only the named clauses for
          selected slices, and approving it carries an accepted saved plan forward.
        </p>
        <p>
          References and source identities are collected for you. Recommendations remain proposals
          until you explicitly approve their exact text. Approval here and in Needs you creates the
          same shared record; it never resumes a run.
        </p>
      </About>
      {data && data.blockers.length > 0 && (
        <p className="warning-state">Approval unavailable: {data.blockers.join(' ')}</p>
      )}
      {data && (
        <BatchApproval
          data={data}
          csrfToken={csrfToken}
          disabled={disabled}
          onChanged={onChanged}
        />
      )}
      {[...decisions]
        .sort((a, b) => Number(accepted(a)) - Number(accepted(b)))
        .map((d) => card(d.checkpointId))}
      {(view.architectureDecisions?.checkpoints.length ?? 0) > 0 && (
        <details id={roadmapId ? `decision-preparation-${roadmapId}` : undefined}>
          <summary>Prepare or write another decision</summary>
          {!unlisted.length && (
            <p className="empty-state">Every decision of this map is listed above.</p>
          )}
          {unlisted.length > 0 && (
            <label className="field">
              Decision
              <select value={other} disabled={disabled} onChange={(e) => setOther(e.target.value)}>
                <option value="">Choose a decision</option>
                {unlisted.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {other && !listed.has(other) && card(other)}
        </details>
      )}
    </Section>
  );
}
