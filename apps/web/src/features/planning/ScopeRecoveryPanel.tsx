import { useState } from 'react';
import type { Roadmap, RoadmapView, WorkItemId } from '@craftingtable/domain';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { configureScopeRecovery } from '../../lib/roadmap-api.js';

export function ScopeRecoveryPanel({
  roadmap,
  csrfToken,
  canMutate,
  onChange,
  onOpenWorkItem,
}: {
  roadmap: Roadmap;
  csrfToken: string;
  canMutate: boolean;
  onChange: (view: RoadmapView) => void;
  onOpenWorkItem: (id: WorkItemId) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [limit, setLimit] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const rounds = roadmap.attempts.filter((a) => a.recovery);
  const parents = [
    ...new Set(
      rounds
        .map((a) => roadmap.definition.entries.find((e) => e.id === a.entryId)?.workItemId)
        .filter((id): id is WorkItemId => !!id),
    ),
  ];
  const editable = ['draft', 'paused', 'needs-attention'].includes(roadmap.status);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onChange(
        await configureScopeRecovery(
          roadmap,
          { expectedVersion: roadmap.version, enabled, maxRoundsPerParent: limit },
          csrfToken,
        ),
      );
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save recovery delegation.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      id={`scope-recovery-${roadmap.id}`}
      title="Independent review recovery"
      summary={
        roadmap.scopeRecovery?.enabled
          ? `Automatic · up to ${roadmap.scopeRecovery.maxRoundsPerParent} repair rounds per parent`
          : 'Manual · independent findings wait for your direction'
      }
    >
      <About label="About independent review recovery">
        <p>
          Each round repairs findings in one unambiguous owning slice, follows that slice’s
          integration merge policy, refreshes independent verification, and retries parent
          acceptance. Questions, ambiguous ownership, unchanged findings and exhausted allowances
          need you.
        </p>
        <p>
          The total allowance follows each parent across worktrees and restarts. Each repair also
          retains the slice’s existing remediation limit and models. Final promotion remains your
          decision.
        </p>
        <p>
          Saving recovery delegation does not change the saved plan; Start/Resume delegates
          execution. Manual repairs remain available.
        </p>
      </About>
      {parents.map((id) => {
        const entry = roadmap.definition.entries.find((e) => e.workItemId === id)!;
        const history = rounds.filter(
          (a) => roadmap.definition.entries.find((e) => e.id === a.entryId)?.workItemId === id,
        );
        const active = history.find((a) => a.recovery!.phase !== 'completed');
        const phase = active?.recovery?.phase;
        return (
          <div key={id} className="card">
            <button type="button" className="text-button" onClick={() => onOpenWorkItem(id)}>
              {entry.sourceId.split('/').slice(0, 2).join('/')}:{' '}
              {history.filter((a) => !a.recovery!.requestedByUserId).length} /{' '}
              {roadmap.scopeRecovery?.maxRoundsPerParent ?? 0} automatic rounds used
            </button>
            <p>
              {active
                ? phase === 'repair'
                  ? 'Owning-slice repair / integration'
                  : phase === 'verification'
                    ? 'Fresh independent verification'
                    : 'Retrying parent acceptance'
                : 'Previous recovery rounds finished.'}
            </p>
            <details>
              <summary>Recovery history ({history.length})</summary>
              <ol>
                {history.map((a, i) => (
                  <li key={a.id}>
                    Round {i + 1}: {a.recovery!.phase} ·{' '}
                    <time>{new Date(a.createdAt).toLocaleString()}</time>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        );
      })}
      {error && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}
      {canMutate && !editing && (
        <button
          type="button"
          className="secondary-button"
          disabled={!editable}
          onClick={() => {
            setEnabled(roadmap.scopeRecovery?.enabled ?? true);
            setLimit(roadmap.scopeRecovery?.maxRoundsPerParent ?? 3);
            setEditing(true);
          }}
        >
          Configure review recovery
        </button>
      )}
      {canMutate && !editable && !['stopped', 'completed'].includes(roadmap.status) && (
        <p className="muted">Pause roadmap scheduling to change this delegation.</p>
      )}
      {editing && (
        <form
          className="stack-form"
          aria-label="Recovery delegation"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Automatically recover independent review findings
          </label>
          <label className="field">
            Total automatic repair rounds per parent
            <input
              type="number"
              min={1}
              max={20}
              value={limit}
              disabled={busy}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </label>
          <p className="muted">
            A total ceiling, not extra attempts; prior automatic rounds remain counted. Saving does
            not start runs.
          </p>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !editable || !Number.isInteger(limit) || limit < 1 || limit > 20}
          >
            Save recovery delegation
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        </form>
      )}
    </Section>
  );
}
