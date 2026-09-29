import { useState } from 'react';
import type { AgentRunDetailResponse } from '@craftingtable/contracts';
import { asAgentRunId, asWorkspaceId } from '@craftingtable/domain';
import { loadRun } from '../../lib/execution-api.js';
import { RunCompletionIssue, RunOutcome } from './RunOutcome.js';
import { Link } from '../../lib/navigation.js';
import type { AgentRunId, WorkspaceId } from '@craftingtable/domain';

/** Fetch large reports only on demand, keeping roadmap refreshes small and disclosures stable. */
export function SourceRunReport({
  workspaceId,
  runId,
  label,
}: {
  workspaceId: string;
  runId: string;
  label: string;
}) {
  const [detail, setDetail] = useState<AgentRunDetailResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    if (busy || detail) return;
    setBusy(true);
    setError('');
    try {
      setDetail(await loadRun(asWorkspaceId(workspaceId), asAgentRunId(runId)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the recorded report.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      onToggle={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.open && !error) void load();
      }}
    >
      <summary>{label}</summary>
      <p>
        Agent evidence and recommendations are not an approval or a passing verification receipt.
      </p>
      <Link
        route={{ name: 'run', workspaceId: workspaceId as WorkspaceId, runId: runId as AgentRunId }}
      >
        Open source run
      </Link>
      {busy && <p role="status">Loading recorded report…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>
            Retry loading report
          </button>
        </div>
      )}
      <RunCompletionIssue issue={detail?.completionIssue} />
      {detail?.latestOutcome ? (
        <RunOutcome
          outcome={detail.latestOutcome}
          finished={detail.run.status === 'finished'}
          assessment={detail.reviewReport}
        />
      ) : detail ? (
        <p>No final message was recorded for this run.</p>
      ) : null}
    </details>
  );
}
