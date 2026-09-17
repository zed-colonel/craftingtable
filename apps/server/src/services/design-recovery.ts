import { createHash } from 'node:crypto';
import type { AgentRunId, DesignRecoverySource, WorkCycle } from '@craftingtable/domain';
import type { DesignRecoveryPreview } from '@craftingtable/contracts';
import { decodeUtf8, readArchive } from '@craftingtable/planning';
import type { StorageRepositories } from '@craftingtable/storage';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { activeRuntime } from './runtime-evidence-policy.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** Explicit, bounded discovery from exact plan versions only; never scans the host filesystem. */
export function collectDesignRecovery(
  tx: StorageRepositories,
  cycle: WorkCycle,
  sourceRunId: AgentRunId = tx.execution.runs.find(cycle.workspaceId, cycle.currentRunId)
    ? cycle.currentRunId
    : (cycle.parentRunId ?? cycle.currentRunId),
): DesignRecoveryPreview {
  const ws = cycle.workspaceId;
  const tree = tx.execution.worktrees.find(ws, cycle.worktreeId);
  const item = cycle.workItemId && tx.planning.workItems.find(ws, cycle.workItemId);
  const run = tx.execution.runs.find(ws, sourceRunId);
  if (!tree || !item || !run || run.worktreeId !== tree.id || run.role !== 'design')
    throw new NotFoundError();
  const event = tx.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
  const report =
    event?.kind === 'turn-completed' ? event.payload.resultText : (run.outcomeSummary ?? '');
  const questions =
    report.match(/^## Open questions\s*\n([\s\S]*)/im)?.[1]?.trim() ||
    report ||
    'No final design report was recorded. Inspect the run before continuing.';
  // Exact contract/requirement IDs are useful cross-package lookup keys; prose is not authority.
  const identifiers = [
    ...new Set(report.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}\b/g) ?? []),
  ].slice(0, 64);
  const scope = cycle.executionScope;
  const binding =
    scope &&
    tx.imports
      .bindings(ws, scope.definitionId)
      .find((entry) => entry.revision === scope.bindingRevision);
  const runtime = scope && activeRuntime(tx, ws, scope.definitionId, scope.bindingRevision);
  const versions = [
    ...new Set([
      item.planVersionId,
      ...(binding?.bindings.flatMap((b) => (b.planVersionId ? [b.planVersionId] : [])) ?? []),
    ]),
  ];
  if (versions.length > 8)
    throw new ExecutionRequestError(
      'conflict',
      'Design discovery supports at most eight exact bound plans.',
    );
  const notices = [
    'Saved repository and dependency identities are context, not fresh Git observations or passing test evidence.',
    'Repository tags, remote protection, ownership decisions and historical measurements are not approved by discovery.',
    'Shared documents are source material from exact bound plans; conflicting revisions still require a decision.',
  ];
  if (event?.kind === 'turn-completed' && event.payload.truncated)
    notices.push(
      'The source report was marked truncated. Consult its complete handoff and resolve every question before continuing.',
    );
  const candidates: DesignRecoveryPreview['sources'] = [];
  let scannedBytes = 0;
  const add = (source: DesignRecoverySource, content: string) => {
    if (!identifiers.some((id) => content.includes(id))) return;
    if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
      notices.push(
        `Matching source is too large for automatic inclusion: ${source.name}. Consult its preserved plan archive.`,
      );
      return;
    }
    candidates.push({ source: { ...source }, content });
  };
  for (const planVersionId of versions) {
    for (const info of tx.planning.artifacts.listForVersion(ws, planVersionId)) {
      const artifact = tx.planning.artifacts.findWithContent(ws, info.id);
      if (artifact)
        add(
          { planVersionId, artifactId: info.id, name: info.logicalFilename, digest: info.sha256 },
          Buffer.from(artifact.content).toString('utf8'),
        );
    }
    const links = tx.imports.planLinks(ws, planVersionId);
    if (links.length > 8)
      throw new ExecutionRequestError(
        'conflict',
        'Too many linked archives for bounded design discovery.',
      );
    for (const link of links) {
      const archive = tx.imports.archive(ws, link.archiveId);
      if (!archive) continue;
      for (const entry of readArchive(archive.content)) {
        scannedBytes += entry.bytes.byteLength;
        if (scannedBytes > 64 * 1024 * 1024)
          throw new ExecutionRequestError(
            'conflict',
            'Bound plans exceed the 64 MiB discovery scan limit.',
          );
        // Historical snapshots and executable package helpers are not current normative inputs.
        if (
          !/\.(md|ya?ml|json|txt|toml)$/i.test(entry.path) ||
          /(^|\/)(provenance|archive|validation-logs|review-diffs)\//i.test(entry.path)
        )
          continue;
        let content: string;
        try {
          decodeUtf8(entry.bytes);
          content = Buffer.from(entry.bytes).toString('utf8');
        } catch {
          continue;
        }
        add(
          {
            planVersionId,
            archiveId: archive.id,
            archiveDigest: archive.digest,
            name: entry.path,
            digest: entry.sha256,
          },
          content,
        );
      }
    }
  }
  // Keep documents already used to answer this design, even when the latest report no longer
  // repeats their identifiers. Their immutable bytes remain available to implementation/review.
  for (const source of cycle.designRecovery?.sources ?? []) {
    if (versions.includes(source.planVersionId))
      candidates.push({
        source: { ...source },
        content: readDesignRecoverySource(tx, cycle, source),
      });
  }
  // Put contract definitions ahead of large documents merely citing the identifier.
  candidates.sort(
    (a, b) =>
      Number(/contract/i.test(b.source.name)) - Number(/contract/i.test(a.source.name)) ||
      a.source.name.localeCompare(b.source.name),
  );
  const sources: DesignRecoveryPreview['sources'] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let omitted = 0;
  for (const entry of candidates) {
    if (seen.has(entry.source.digest)) continue;
    seen.add(entry.source.digest);
    const size = Buffer.byteLength(entry.content);
    if (sources.length >= 32 || bytes + size > MAX_TOTAL_BYTES) {
      omitted++;
      continue;
    }
    bytes += size;
    sources.push(entry);
  }
  if (omitted)
    notices.push(
      `${omitted} further matching documents exceed the bounded recovery package. The original plan archives remain available.`,
    );
  if (!sources.length)
    notices.push(
      'No additional documents matched exact identifiers in this report. The ordinary work-item plan and full handoff will still accompany the run.',
    );
  const facts = JSON.stringify(
    {
      kind: 'design-recovery-context-v1',
      sourceRunId,
      sourceReportDigest: digest(report),
      workItem: { id: item.id, planVersionId: item.planVersionId, sourceId: item.sourceId },
      worktree: {
        id: tree.id,
        repositoryId: tree.repositoryId,
        branch: tree.branchName,
        baseSha: tree.baseSha,
        integrationBranch: tree.integrationBranch,
      },
      baselinePreparation: cycle.baselinePreparation,
      scope,
      mapDigest: scope ? tx.imports.definition(ws, scope.definitionId)?.digest : undefined,
      binding,
      runtime: runtime
        ? {
            id: runtime.id,
            digest: runtime.digest,
            generation: runtime.generation,
            pins: runtime.pins,
            consumers: runtime.consumers,
          }
        : undefined,
      sources: sources.map((entry) => entry.source),
    },
    null,
    2,
  );
  if (facts.length > 128000)
    throw new ExecutionRequestError('conflict', 'Recovery context exceeds its bounded size.');
  return {
    expectedVersion: cycle.version,
    sourceRunId,
    questions,
    facts,
    snapshotDigest: digest(facts),
    sources,
    notices,
  };
}

/** Materialize only preserved, byte-matching source records, never a browser-supplied path. */
export function readDesignRecoverySource(
  tx: StorageRepositories,
  cycle: WorkCycle,
  source: DesignRecoverySource,
): string {
  let content: string | undefined;
  if (source.artifactId) {
    const artifact = tx.planning.artifacts.findWithContent(cycle.workspaceId, source.artifactId);
    if (artifact?.planVersionId === source.planVersionId)
      content = Buffer.from(artifact.content).toString('utf8');
  } else if (
    source.archiveId &&
    tx.imports
      .planLinks(cycle.workspaceId, source.planVersionId)
      .some((link) => link.archiveId === source.archiveId)
  ) {
    const archive = tx.imports.archive(cycle.workspaceId, source.archiveId);
    if (archive && archive.digest === source.archiveDigest) {
      const entry = readArchive(archive.content).find((entry) => entry.path === source.name);
      if (entry) {
        decodeUtf8(entry.bytes);
        content = Buffer.from(entry.bytes).toString('utf8');
      }
    }
  }
  if (content === undefined || digest(content) !== source.digest)
    throw new ExecutionRequestError(
      'conflict',
      'A recovery source no longer matches its preserved identity. Refresh discovery.',
    );
  return content;
}
