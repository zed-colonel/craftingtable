import { useState } from 'react';
import type { Roadmap, RoadmapView } from '@craftingtable/domain';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { configureReverification } from '../../lib/roadmap-api.js';

/**
 * The standing, revocable grant for the scheduler to re-verify an entry whose evidence went stale
 * (R-C10's follow-up, decision 4), beside independent review recovery's: off until the operator
 * turns it on, and changed at any status but ended (R-B6, decision 4).
 */
export function ReverificationGrantPanel({
  roadmap,
  csrfToken,
  canMutate,
  onChange,
}: {
  roadmap: Roadmap;
  csrfToken: string;
  canMutate: boolean;
  onChange: (view: RoadmapView) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editable = !['stopped', 'completed'].includes(roadmap.status);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onChange(
        await configureReverification(
          roadmap,
          { expectedVersion: roadmap.version, enabled },
          csrfToken,
        ),
      );
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save automatic re-verification.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      id={`reverification-${roadmap.id}`}
      title="Automatic re-verification"
      summary={
        roadmap.reverificationGrant?.enabled
          ? 'Automatic · stale evidence is reviewed again in place'
          : 'Manual · stale evidence waits for your Re-verify'
      }
    >
      <About label="About automatic re-verification">
        <p>
          When approved decisions or a newer repository policy make a verification's or an automatic
          parent acceptance's evidence stale, the roadmap runs its review again in place, with its
          assigned reviewer, once approvals have settled for ten minutes, and once for each stale
          receipt.
        </p>
        <p>
          Evidence stale for any other reason, or whose review cycle or worktree has gone, still
          waits for your Re-verify.
        </p>
      </About>
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
            setEnabled(roadmap.reverificationGrant?.enabled ?? true);
            setEditing(true);
          }}
        >
          Configure automatic re-verification
        </button>
      )}
      {editing && (
        <form
          className="stack-form"
          aria-label="Re-verification grant"
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
            Re-verify stale evidence automatically
          </label>
          <button type="submit" className="primary-button" disabled={busy || !editable}>
            Save re-verification grant
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
