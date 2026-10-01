import type { CheckDefinitionDiagnosisView } from '@craftingtable/contracts';
import type { WorkspaceId, WorktreeId } from '@craftingtable/domain';
import { useEffect, useMemo, useState } from 'react';
import { loadCheckDefinitions } from '../../lib/execution-api.js';
import { shortSha } from '../../lib/execution-labels.js';
import { lineDiff } from '../../lib/line-diff.js';
import {
  differsOnlyInWhitespace,
  hasMarked,
  visible,
  visibleDefinition,
} from '../../lib/visible-text.js';

type DefinitionChange = NonNullable<CheckDefinitionDiagnosisView['merge']>['definitions'][number];

/** One definition file: what is adopted now, and what the merge would adopt. */
function DefinitionDiff({ change }: { change: DefinitionChange }) {
  const { adopted, proposed } = change;
  // Computed once per definition, not on every keystroke of the rationale.
  const lines = useMemo(
    () =>
      adopted?.text !== undefined && proposed?.text !== undefined
        ? lineDiff(adopted.text, proposed.text)
        : undefined,
    [adopted?.text, proposed?.text],
  );
  const marked = [change.path, adopted?.text, proposed?.text].some(
    (t) => t !== undefined && hasMarked(t),
  );
  return (
    <div className="check-definition-diff">
      <p>
        <code>{visible(change.path)}</code>:{' '}
        {!adopted
          ? 'added to the adopted definitions.'
          : !proposed
            ? 'no longer a definition file.'
            : `changed (${shortSha(adopted.digest)} → ${shortSha(proposed.digest)}).`}
      </p>
      {marked && (
        <p className="warning-state">
          This file holds characters outside plain ASCII; each is shown as ⟦U+…⟧.
        </p>
      )}
      {adopted && adopted.text === undefined && proposed && (
        <p className="hint">
          The adopted text cannot be shown: it is not short UTF-8 text, or its commit no longer
          holds it.
        </p>
      )}
      {(adopted?.truncated || proposed?.truncated) && (
        <p className="warning-state">
          Shown only in part:{' '}
          {proposed?.truncated ? 'the text the merge adopts' : 'the adopted text'} is longer than
          this view shows.
        </p>
      )}
      {adopted?.text !== undefined &&
        proposed?.text !== undefined &&
        differsOnlyInWhitespace(adopted.text, proposed.text) && (
          <p className="warning-state">
            The texts differ only in spaces, tabs or line ends, which can change what a script does:
            tabs are shown as →, trailing spaces as ·.
          </p>
        )}
      {adopted?.text !== undefined &&
        proposed?.text !== undefined &&
        !adopted.truncated &&
        !proposed.truncated &&
        !lines && (
          <p className="hint">Too long to compare line by line here; both texts are shown.</p>
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
                {visibleDefinition(line.text)}
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
              <pre>{visibleDefinition(adopted.text)}</pre>
            </details>
          )}
          {proposed?.text !== undefined ? (
            <details open>
              <summary>Text the merge adopts</summary>
              <pre>{visibleDefinition(proposed.text)}</pre>
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
          <code className="exact-text">{visible(JSON.stringify(check.argv))}</code>; definition
          files:{' '}
          {check.definitionPaths.length ? (
            <code className="exact-text">{visible(JSON.stringify(check.definitionPaths))}</code>
          ) : (
            'none'
          )}
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
  /** What an approval names: the proposal's digest and the adoption it was compared with. */
  onProposal: (proposal: { digest: string; declarationId: string } | undefined) => void;
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
        onProposal(
          next.merge?.proposalDigest && !next.merge.issues.length
            ? { digest: next.merge.proposalDigest, declarationId: next.declaration.id }
            : undefined,
        );
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
          {(merge.warnings ?? []).map((warning) => (
            <p key={warning} className="hint" role="note">
              {visible(warning)}
            </p>
          ))}
          {merge.issues.length > 0 ? (
            <div className="error-state" role="status">
              <p>The merge cannot adopt these checks:</p>
              <ul>
                {merge.issues.map((issue) => (
                  <li key={issue}>{visible(issue)}</li>
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
