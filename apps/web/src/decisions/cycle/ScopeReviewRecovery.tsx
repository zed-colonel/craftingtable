import type { WorkCycle, WorkItemId } from '@craftingtable/domain';
import { useEffect, useRef, useState } from 'react';
import { queryKeys } from '../../lib/event-invalidations.js';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';
import { About } from '../../components/About.js';
import { type AnswerDraft, answerFieldId, useAnswerDraft } from './answer-draft.js';

export function ScopeReviewRecovery({
  cycle,
  disabled,
  onResume,
  answer,
}: {
  cycle: WorkCycle;
  disabled: boolean;
  onResume: (instructions: string) => void;
  /** The stop's answer as its decision holds it (R-C16); the form's own state otherwise. */
  answer?: AnswerDraft;
}) {
  const [instructions, setInstructions] = useAnswerDraft(answer);
  const [retry, setRetry] = useState(0);
  // The work item's slices, shared with its page (R-D4 increment 4b): read again on its events,
  // and here when the cycle changes or the operator retries, holding Resume until then.
  const store = useQueryStore();
  const key = cycle.workItemId
    ? queryKeys.workItemScopes(cycle.workspaceId, cycle.workItemId)
    : undefined;
  const scopes = useQuery(key, () =>
    loadExecutionScopes(cycle.workspaceId, cycle.workItemId as WorkItemId),
  );
  const [refetching, setRefetching] = useState(false);
  const mounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new cycle version or a retry reads again.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (key === undefined) return;
    let alive = true;
    setRefetching(true);
    void store.refetch(key).finally(() => {
      if (alive) setRefetching(false);
    });
    return () => {
      alive = false;
    };
  }, [cycle.version, retry]);
  const choices = scopes.data?.choices;
  const error =
    !refetching && scopes.error !== undefined
      ? scopes.error instanceof Error
        ? scopes.error.message
        : 'Could not load review requirements.'
      : undefined;
  const refreshing = key === undefined || scopes.status !== 'ready' || refetching;
  const scope = cycle.executionScope;
  const choice = choices?.find(
    (c) =>
      c.scope.definitionId === scope?.definitionId &&
      c.scope.bindingRevision === scope.bindingRevision &&
      c.scope.sourceId === scope.sourceId &&
      c.scope.kind === (scope.kind === 'parent-acceptance' ? 'parent-acceptance' : 'slice'),
  );
  const phase = choice?.phases.find(
    (p) => p.phase === (scope?.kind === 'parent-acceptance' ? 'accept' : 'verify'),
  );
  const blockers = phase?.blockers ?? [];
  const repeat = cycle.status === 'completed';
  return (
    <form
      aria-label="Recover scope review"
      className="stack-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && !refreshing && !error && phase && !blockers.length) onResume(instructions);
      }}
    >
      <h3>
        {cycle.providerRecovery?.nextRetryAt
          ? 'Resume interrupted review'
          : repeat
            ? 'Review again'
            : scope?.kind === 'parent-acceptance'
              ? 'Recover parent acceptance'
              : 'Recover slice verification'}
      </h3>
      <p>
        {repeat
          ? 'Starts a fresh review with this cycle’s reviewer in the existing worktree.'
          : 'Merge source fixes first. Resuming does not delegate implementation or accept this scope.'}
      </p>
      <About label="About review recovery">
        {cycle.providerRecovery?.nextRetryAt && (
          <p>
            Resume preserves the interrupted review snapshot, service-retry allowance and original
            deadline, with your additional guidance. Roadmap pauses hold dispatch; current branch
            and phase gates are rechecked before launch.
          </p>
        )}
        <p>
          {repeat
            ? 'The controller requires an idle, clean snapshot and updates it from integration without overwriting changes. Earlier runs and evidence remain in history.'
            : 'Resume updates this idle, clean snapshot from integration and starts a fresh review with the saved repository policy, earlier findings, and your additional guidance.'}
        </p>
      </About>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {refreshing && !error && <p role="status">Checking current review requirements…</p>}
      {choices && !phase && (
        <p className="warning-state">
          The bound scope is unavailable. Review its exact plan binding before resuming.
        </p>
      )}
      {blockers.length > 0 && (
        <div className="warning-state">
          <strong>Before this review can resume</strong>
          <ul>
            {blockers.map((b) => (
              <li key={`${b.kind}:${b.message}`}>{b.message}</li>
            ))}
          </ul>
          <p>
            <a href="#slices">Open execution slices and verification controls</a> to prepare the
            fresh reviews. Launch them from Delegation; record verification after a qualifying
            result.
          </p>
        </div>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={disabled}
        onClick={() => setRetry((v) => v + 1)}
      >
        Refresh review requirements
      </button>
      <label className="field">
        Additional review guidance
        <textarea
          id={answerFieldId(cycle.id)}
          value={instructions}
          maxLength={16000}
          disabled={disabled}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className="primary-button"
        disabled={disabled || refreshing || !!error || !phase || !!blockers.length}
      >
        {repeat ? 'Start fresh scope review' : 'Resume scope review'}
      </button>
    </form>
  );
}
