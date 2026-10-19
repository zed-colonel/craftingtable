import type { CycleDefaultsResponse } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import { ApiError } from '../../lib/api-client.js';
import { loadCycleDefaults, saveCycleDefaults } from '../../lib/cycle-defaults-api.js';

/**
 * The workspace's default step time limit (R-C17 part 4, decisions 8 and 9): the minutes per step
 * that new cycles, roadmap entries, map settings and finalization stages start with. Existing
 * cycles and saved entries keep theirs.
 */
export function CycleDefaultsPanel({
  workspaceId,
  csrfToken,
  canEdit,
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
  canEdit: boolean;
}) {
  const [defaults, setDefaults] = useState<CycleDefaultsResponse>();
  const [minutes, setMinutes] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    let live = true;
    void loadCycleDefaults(workspaceId)
      .then((read) => {
        if (!live) return;
        setDefaults(read);
        setMinutes(read.maxRunMinutes);
      })
      .catch((failure: unknown) => {
        if (live)
          setError(failure instanceof ApiError ? failure.message : 'The default could not be read');
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  return (
    <Section
      id="workspace-cycle-defaults"
      title="Step time limit"
      summary="The minutes per step that new cycles and roadmap entries start with."
    >
      <About label="About the step time limit">
        <p>
          A step that runs longer is stopped for you, with its work kept. New automated cycles, new
          roadmap entries, new map settings and new finalization stages start with this limit; each
          form can still change it. Existing cycles and saved entries keep theirs; a stopped cycle’s
          limit is changed under its own settings.
        </p>
      </About>
      {defaults === undefined ? (
        error === undefined && <p className="empty-state">Loading the step time limit…</p>
      ) : (
        <form
          className="stack-form"
          aria-label="Default step time limit"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canEdit || busy || !valid) return;
            setBusy(true);
            setError(undefined);
            setNotice(undefined);
            void saveCycleDefaults(workspaceId, { maxRunMinutes: minutes }, csrfToken)
              .then((saved) => {
                setDefaults(saved);
                setNotice('Step time limit saved.');
              })
              .catch((failure: unknown) =>
                setError(
                  failure instanceof ApiError ? failure.message : 'The default could not be saved',
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label className="field">
            Minutes per step for new work
            <input
              type="number"
              min={1}
              max={1440}
              value={minutes}
              disabled={!canEdit || busy}
              onChange={(event) => setMinutes(Number(event.target.value))}
            />
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={!canEdit || busy || !valid || minutes === defaults.maxRunMinutes}
          >
            Save step time limit
          </button>
        </form>
      )}
      {notice !== undefined && (
        <p className="success-state" role="status">
          {notice}
        </p>
      )}
      {error !== undefined && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
