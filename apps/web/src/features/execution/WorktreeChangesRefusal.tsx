import type { ApiErrorDetail } from '../../lib/api-client.js';
import { ApiError } from '../../lib/api-client.js';

/** A removal the daemon refused because it would discard uncommitted or untracked work. */
export interface WorktreeChangesRefused {
  readonly paths: readonly string[];
  readonly pathCount?: number;
}

/** The refusal carried by an error, if the daemon refused a removal to protect changes. */
export function worktreeChangesRefused(error: unknown): WorktreeChangesRefused | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const detail: ApiErrorDetail = error.detail;
  if (detail.reason !== 'worktree-has-changes') return undefined;
  return {
    paths: detail.paths ?? [],
    ...(detail.pathCount === undefined ? {} : { pathCount: detail.pathCount }),
  };
}

/**
 * Names the paths a worktree removal would lose and offers the one explicit
 * way to lose them. Removal never discards work without this second choice.
 */
export function WorktreeChangesRefusal({
  refused,
  busy,
  onDiscard,
  onKeep,
}: {
  refused: WorktreeChangesRefused;
  busy: boolean;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  const total = refused.pathCount ?? refused.paths.length;
  const hidden = total - refused.paths.length;
  return (
    <div className="warning-state" role="alert">
      <p>
        {refused.pathCount === undefined && refused.paths.length === 0
          ? 'This worktree has uncommitted or untracked changes.'
          : `This worktree has ${total} uncommitted or untracked path${total === 1 ? '' : 's'}.`}{' '}
        Removing it now would delete them.
      </p>
      {refused.paths.length > 0 && (
        <ul>
          {refused.paths.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
          {hidden > 0 && <li>…and {hidden} more</li>}
        </ul>
      )}
      <div className="inline-actions">
        <button type="button" className="text-button danger" disabled={busy} onClick={onDiscard}>
          Discard changes and remove
        </button>
        <button type="button" className="ghost-button" disabled={busy} onClick={onKeep}>
          Keep worktree
        </button>
      </div>
    </div>
  );
}
