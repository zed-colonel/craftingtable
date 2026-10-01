import type { CheckDefinitionDiagnosisView } from '@craftingtable/contracts';
import type { WorkspaceId, WorktreeId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { loadCheckDefinitions } from '../../lib/execution-api.js';
import { shortSha } from '../../lib/execution-labels.js';
import { lineDiff } from '../../lib/line-diff.js';

type DefinitionChange = NonNullable<CheckDefinitionDiagnosisView['merge']>['definitions'][number];

/** One definition file: what is adopted now, and what the merge would adopt. */
function DefinitionDiff({ change }: { change: DefinitionChange }) {
  const { adopted, proposed } = change;
  const lines =
    adopted?.text !== undefined && proposed?.text !== undefined
      ? lineDiff(adopted.text, proposed.text)
      : undefined;
  return (
    <div className="check-definition-diff">
      <p>
        <code>{change.path}</code>:{' '}
        {!adopted
          ? 'added to the adopted definitions.'
          : !proposed
            ? 'no longer a definition file.'
            : `changed (${shortSha(adopted.digest)} → ${shortSha(proposed.digest)}).`}
      </p>
      {(adopted?.truncated || proposed?.truncated) && (
        <p className="warning-state">
          Shown only in part:{' '}
          {proposed?.truncated ? 'the text the merge adopts' : 'the adopted text'} is longer than
          this view shows.
        </p>
      )}
      {lines && !adopted?.truncated && !proposed?.truncated ? (
        <figure aria-label={`Changes to ${change.path}`} className="line-diff">
          <pre>
            {lines.map((line, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own.
                key={index}
                className={`line-diff-${line.kind}`}
              >
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                {line.text}
                {'\n'}
              </span>
            ))}
          </pre>
        </figure>
      ) : (
        <>
          {adopted?.text !== undefined && (
            <details>
              <summary>Adopted text</summary>
              <pre>{adopted.text}</pre>
            </details>
          )}
          {proposed?.text !== undefined ? (
            <details open>
              <summary>Text the merge adopts</summary>
              <pre>{proposed.text}</pre>
            </details>
          ) : (
            proposed && <p className="hint">Not shown: the file is not short text.</p>
          )}
        </>
      )}
    </div>
  );
}

type Check = NonNullable<CheckDefinitionDiagnosisView['merge']>['proposedChecks'][number];

/**
 * One added, removed or changed check, its command exactly as JSON (an argument boundary is
 * part of the command) and its definition files, adopted and proposed (review F2).
 */
function CheckChange({
  id,
  change,
  adopted,
  proposed,
}: {
  id: string;
  change: 'added' | 'removed' | 'changed';
  adopted: Check | undefined;
  proposed: Check | undefined;
}) {
  const facts = (label: string, check: Check | undefined) =>
    check && (
      <>
        <dt>{label}</dt>
        <dd>
          <code>{JSON.stringify(check.argv)}</code>; definition files:{' '}
          {check.definitionPaths.length ? <code>{check.definitionPaths.join(', ')}</code> : 'none'}
        </dd>
      </>
    );
  return (
    <fieldset aria-label={`Check ${id} ${change}`} className="check-change">
      <legend>
        Check <code>{id}</code> {change}
      </legend>
      <dl>
        {facts('Adopted', adopted)}
        {facts('Merge adopts', proposed)}
      </dl>
    </fieldset>
  );
}

/**
 * The check definitions a slice's merge adopts (R-G13 increment 5, operator decision
 * 2026-09-30). The operator reads them here; approving the merge with a rationale adopts them
 * at the merge commit. `onProposal` reports the digest the approval names, or undefined while
 * there is nothing the merge can adopt.
 */
export function CheckAdoptionReview({
  workspaceId,
  worktreeId,
  rationale,
  onRationale,
  onProposal,
  disabled,
}: {
  workspaceId: WorkspaceId;
  worktreeId: WorktreeId;
  rationale: string;
  onRationale: (value: string) => void;
  onProposal: (digest: string | undefined) => void;
  disabled: boolean;
}) {
  const [diagnosis, setDiagnosis] = useState<CheckDefinitionDiagnosisView>();
  const [error, setError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: onProposal is the host's setter.
  useEffect(() => {
    let alive = true;
    onProposal(undefined);
    void loadCheckDefinitions(workspaceId, worktreeId)
      .then((next) => {
        if (!alive) return;
        setDiagnosis(next);
        onProposal(next.merge && !next.merge.issues.length ? next.merge.proposalDigest : undefined);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, worktreeId]);
  const merge = diagnosis?.merge;
  return (
    <section aria-label="Check definitions this merge adopts" className="check-adoption-review">
      {error && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}
      {!diagnosis && !error && <p>Loading the check definitions…</p>}
      {diagnosis && !merge && (
        <p>This merge changes no adopted check definition. Reload the page.</p>
      )}
      {diagnosis && merge && (
        <>
          <p>
            Approving the merge adopts these checks as version {diagnosis.declaration.version + 1}{' '}
            (now version {diagnosis.declaration.version}, from{' '}
            {shortSha(diagnosis.declaration.sourceCommit)}). Later reviews are held to them.
          </p>
          {merge.checks.map((c) => (
            <CheckChange
              key={c.id}
              id={c.id}
              change={c.change}
              adopted={merge.adoptedChecks?.find((a) => a.id === c.id)}
              proposed={merge.proposedChecks.find((p) => p.id === c.id)}
            />
          ))}
          {merge.definitions.map((change) => (
            <DefinitionDiff key={change.path} change={change} />
          ))}
          {merge.issues.length > 0 ? (
            <div className="error-state" role="status">
              <p>The merge cannot adopt these checks:</p>
              <ul>
                {merge.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : (
            <label className="field">
              Why adopt these definitions
              <textarea
                value={rationale}
                onChange={(event) => onRationale(event.target.value)}
                disabled={disabled}
                maxLength={2000}
                required
              />
            </label>
          )}
        </>
      )}
    </section>
  );
}
