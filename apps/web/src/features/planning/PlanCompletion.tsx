import type { PlanCompletion as Completion } from '@craftingtable/domain';

export function PlanCompletion({
  completion,
  compact = false,
}: {
  completion?: Completion;
  compact?: boolean;
}) {
  if (!completion) return null;
  return (
    <p className="plan-completion" style={{ overflowWrap: 'anywhere' }}>
      <strong>Plan completed</strong> · Merged into <code>{completion.targetBranch}</code>
      {!compact && (
        <>
          <br />
          {new Date(completion.completedAt).toLocaleString()} · Merge{' '}
          <code>{completion.mergeSha}</code>
        </>
      )}
    </p>
  );
}
