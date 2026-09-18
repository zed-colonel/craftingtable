import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';

export function ScopeReviewRecovery({
  cycle,
  disabled,
  refreshToken,
  onResume,
}: {
  cycle: WorkCycle;
  disabled: boolean;
  refreshToken: number;
  onResume: (instructions: string) => void;
}) {
  const [instructions, setInstructions] = useState('');
  const [choices, setChoices] = useState<ExecutionScopeChoice[]>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: daemon events refresh current phase gates.
  useEffect(() => {
    let alive = true;
    setChoices(undefined);
    setError(undefined);
    if (cycle.workItemId)
      void loadExecutionScopes(cycle.workspaceId, cycle.workItemId)
        .then((result) => {
          if (alive) setChoices(result.choices);
        })
        .catch((e) => {
          if (alive)
            setError(e instanceof Error ? e.message : 'Could not load review requirements.');
        });
    return () => {
      alive = false;
    };
  }, [cycle.workspaceId, cycle.workItemId, cycle.version, refreshToken, retry]);
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
  return (
    <form
      aria-label="Recover scope review"
      className="stack-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && phase && !blockers.length) onResume(instructions);
      }}
    >
      <h3>
        {scope?.kind === 'parent-acceptance'
          ? 'Recover parent acceptance'
          : 'Recover slice verification'}
      </h3>
      <p>
        Resume starts a fresh review with the saved repository policy, earlier findings, and your
        additional guidance. It does not delegate implementation or accept this scope.
      </p>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {!choices && !error && <p role="status">Checking current review requirements…</p>}
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
            <a href="#slices">Open execution slices and verification controls</a> to prepare
            required fresh reviews. Use Delegation to launch them and record their verification
            after a qualifying result.
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
          value={instructions}
          maxLength={16000}
          disabled={disabled}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className="primary-button"
        disabled={disabled || !phase || !!blockers.length}
      >
        Resume scope review
      </button>
    </form>
  );
}
