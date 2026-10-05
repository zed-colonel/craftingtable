import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import { type AgentSelection, modelSpelling } from '@craftingtable/domain';

type Backends = ExecutionStatusResponse['backends'];

/**
 * What to tell the operator about a saved model (R-G15): a display name or another spelling of
 * a catalog id, which the daemon will not start, or a model the backend's list no longer has,
 * which is still sent. Nothing when the backend's list is only the release's own, which may
 * simply be older than the model.
 */
export function savedModelNote(backends: Backends, selection: AgentSelection): string | undefined {
  const model = selection.model;
  const backend = backends.find((candidate) => candidate.kind === selection.backend);
  if (model === undefined || backend === undefined || !backend.available) return undefined;
  const spelling = modelSpelling(backend.models, model);
  if (spelling.kind === 'misnamed')
    return `${model} is not an id in ${backend.label}’s model list, and runs that name it are not started; choose ${spelling.id}`;
  if (spelling.kind === 'unlisted' && backend.catalog.source !== 'fallback')
    return `${model} is not in ${backend.label}’s model list; runs still send it`;
  return undefined;
}

/** A warning, never a block, for saved selections whose model the catalog does not list. */
export function SavedModelNotes({
  backends,
  selections,
}: {
  backends: Backends;
  selections: readonly (readonly [label: string, selection: AgentSelection | undefined])[];
}) {
  const notes = selections.flatMap(([label, selection]) => {
    const note = selection && savedModelNote(backends, selection);
    return note ? [`${label}: ${note}.`] : [];
  });
  if (notes.length === 0) return null;
  return (
    <p className="warning-state" role="note">
      {notes.join(' ')}
    </p>
  );
}
