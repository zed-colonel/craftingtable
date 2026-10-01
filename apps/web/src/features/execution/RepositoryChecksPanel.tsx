import type {
  RepositoryCheckReceipts,
  RepositoryChecksView,
  SourceRepositorySummary,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { AdoptChecks, ChecksTable } from '../../decisions/checks/CheckAdoption.js';
import { loadRepositoryCheckReceipts, loadRepositoryChecks } from '../../lib/execution-api.js';
import { shortSha } from '../../lib/execution-labels.js';
import { visible } from '../../lib/visible-text.js';

/** The element a check stop's inbox item opens (R-G13). */
export const repositoryChecksFocus = (repositoryId: string): string =>
  `repository-checks-${repositoryId}`;

type Declaration = RepositoryChecksView['declarations'][number];
type Receipt = RepositoryCheckReceipts['runs'][number]['receipts'][number];

/** What an adoption changed from the one before it, in a few words. */
export function adoptionChanges(next: Declaration, previous: Declaration | undefined): string {
  if (!previous) return 'first adoption';
  const before = new Map(previous.checks.map((c) => [c.id, c]));
  const after = new Map(next.checks.map((c) => [c.id, c]));
  const parts = [
    ...next.checks.filter((c) => !before.has(c.id)).map((c) => `added ${c.id}`),
    ...previous.checks.filter((c) => !after.has(c.id)).map((c) => `removed ${c.id}`),
    ...next.checks
      .filter((c) => before.has(c.id) && JSON.stringify(before.get(c.id)) !== JSON.stringify(c))
      .map((c) => `changed ${c.id}`),
    ...[
      ...new Set([
        ...Object.keys(previous.definitionDigests),
        ...Object.keys(next.definitionDigests),
      ]),
    ]
      .filter((path) => previous.definitionDigests[path] !== next.definitionDigests[path])
      .map((path) => `new ${path}`),
  ];
  return parts.length ? parts.join(', ') : 'no change to the checks';
}

const RECEIPT_KIND: Readonly<Record<Receipt['kind'], string>> = {
  declared: 'Adopted check',
  supplemental: 'Supplemental',
  'pinned-build': 'Pinned build',
  'local-ci': 'Local CI',
  native: 'Native check',
  'self-reported': 'Self-reported',
};
const REQUESTED_BY: Readonly<Record<Receipt['requestedBy'], string>> = {
  daemon: 'CraftingTable',
  agent: 'The agent',
  unknown: 'Unknown: the run wrote its own receipts',
};

/**
 * The repository's recent check runs (R-G13 increment 5): which ran an adopted check, which
 * were supplemental, and who asked. Only adopted checks count for a review's gate.
 */
function CheckReceipts({ data }: { data: RepositoryCheckReceipts }) {
  const rows = data.runs.flatMap((run) => run.receipts.map((receipt) => ({ run, receipt })));
  return (
    <details>
      <summary>Recent check runs ({rows.length})</summary>
      <p className="hint">
        Only adopted checks, run on the reviewed commit, count for a review. Supplemental checks are
        the agent's own.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">Recent check runs</caption>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Check</th>
              <th scope="col">Asked by</th>
              <th scope="col">Result</th>
              <th scope="col">Commit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run, receipt }, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a run may repeat a check.
              <tr key={`${run.runId}-${index}`}>
                <td>
                  {run.role}, {new Date(run.createdAt).toLocaleString()}
                </td>
                <td>
                  {RECEIPT_KIND[receipt.kind]}
                  {receipt.checkId && (
                    <>
                      {' '}
                      <code>{receipt.checkId}</code>
                    </>
                  )}
                  {receipt.declarationVersion && ` (version ${receipt.declarationVersion})`}
                  {receipt.kind !== 'declared' && (
                    <span className="mono hint exact-text"> {visible(receipt.command)}</span>
                  )}
                </td>
                <td>{REQUESTED_BY[receipt.requestedBy]}</td>
                <td>
                  {!receipt.success
                    ? 'Failed'
                    : receipt.clean
                      ? 'Passed'
                      : 'Passed on an unclean tree'}
                  {receipt.definitions === 'differ' && ', with other definitions'}
                </td>
                <td className="mono">{shortSha(receipt.headSha)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * One repository's declared checks (R-G13, operator decision 2026-09-29). The operator reviews
 * the repository's checks file at a commit the daemon reads, then adopts it; scoped reviews in
 * the repository are met only by daemon runs of these checks.
 */
export function RepositoryChecksPanel({
  workspaceId,
  repository,
  csrfToken,
  editable,
  refreshToken,
}: {
  workspaceId: WorkspaceId;
  repository: SourceRepositorySummary;
  csrfToken: string;
  editable: boolean;
  refreshToken: number;
}) {
  const [data, setData] = useState<RepositoryChecksView>();
  const [receipts, setReceipts] = useState<RepositoryCheckReceipts>();
  const [error, setError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on daemon journal changes.
  useEffect(() => {
    let alive = true;
    void loadRepositoryChecks(workspaceId, repository.id)
      .then((next) => {
        if (alive) setData(next);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    void loadRepositoryCheckReceipts(workspaceId, repository.id)
      .then((next) => {
        if (alive) setReceipts(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspaceId, repository.id, refreshToken]);
  const declarations = data?.declarations ?? [];
  const [current] = declarations;
  return (
    <section
      id={repositoryChecksFocus(repository.id)}
      aria-label={`Checks for ${repository.displayName}`}
      className="integration-resolution"
    >
      <h3>{repository.displayName}</h3>
      <p>
        {current
          ? `Version ${current.version}, adopted from ${shortSha(current.sourceCommit)} on ${new Date(current.adoptedAt).toLocaleString()}.`
          : data
            ? 'No adopted checks. Scoped reviews in this repository stop until its checks are adopted.'
            : 'Loading checks…'}
      </p>
      {current && (
        <>
          <ChecksTable
            label={`Adopted checks for ${repository.displayName}`}
            checks={current.checks}
          />
          <p className="hint">Why: {current.rationale}</p>
        </>
      )}
      {declarations.length > 0 && (
        <details>
          <summary>Adoption history ({declarations.length})</summary>
          <ol reversed>
            {declarations.map((d, index) => (
              <li key={d.id}>
                Version {d.version}, {new Date(d.adoptedAt).toLocaleString()}, from{' '}
                {shortSha(d.sourceCommit)}
                {d.adoptedAtMerge
                  ? ', adopted by approving the merge that changed them'
                  : ', adopted on this page'}
                : {visible(adoptionChanges(d, declarations[index + 1]))}. Why: {d.rationale}
              </li>
            ))}
          </ol>
        </details>
      )}
      {receipts && receipts.runs.length > 0 && <CheckReceipts data={receipts} />}
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {editable && data && (
        <AdoptChecks
          workspaceId={workspaceId}
          repository={repository}
          current={current}
          initialRef={repository.defaultBranch}
          csrfToken={csrfToken}
          onAdopted={setData}
        />
      )}
    </section>
  );
}
