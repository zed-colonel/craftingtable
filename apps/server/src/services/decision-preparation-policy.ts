import { createHash } from 'node:crypto';
import { decodeUtf8, readArchive } from '@craftingtable/planning';
import type { DecisionPreparation, WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { decisionBindingDigest } from './architecture-decision-policy.js';
import { ExecutionRequestError } from './errors.js';

export function decisionPreparationForRun(tx: StorageRepositories, ws: WorkspaceId, runId: string) {
  return tx.roadmaps
    .list(ws)
    .flatMap((r) => r.decisionPreparations ?? [])
    .find((p) => p.runId === runId);
}
export function currentDecisionPreparation(tx: StorageRepositories, p: DecisionPreparation) {
  const d = tx.imports.definition(p.workspaceId, p.definitionId);
  return (
    !p.failure &&
    !!d &&
    tx.imports.bindings(p.workspaceId, p.definitionId)[0]?.revision === p.bindingRevision &&
    decisionBindingDigest(tx, d, p.bindingRevision) === p.bindingDigest
  );
}

/** Materialize text from exact bound plan archives only, with strict scan/output budgets. */
export function decisionPreparationDocuments(tx: StorageRepositories, p: DecisionPreparation) {
  const d = tx.imports.definition(p.workspaceId, p.definitionId)!;
  const binding = tx.imports
    .bindings(p.workspaceId, p.definitionId)
    .find((b) => b.revision === p.bindingRevision)!;
  const checkpoint = d.source.checkpoints.find((c) => c.id === p.checkpointId)!;
  const documents: { name: string; content: string }[] = [];
  const notices: string[] = [];
  let scanned = 0,
    included = 0;
  const versions = [
    ...new Set(binding.bindings.flatMap((b) => (b.planVersionId ? [b.planVersionId] : []))),
  ];
  if (versions.length > 8)
    throw new ExecutionRequestError(
      'conflict',
      'Decision preparation supports at most eight exact bound plans.',
    );
  for (const version of versions) {
    const links = tx.imports.planLinks(p.workspaceId, version);
    if (links.length > 8)
      throw new ExecutionRequestError(
        'conflict',
        'Too many source archives for bounded decision preparation.',
      );
    for (const link of links) {
      const archive = tx.imports.archive(p.workspaceId, link.archiveId);
      if (!archive) continue;
      for (const entry of readArchive(archive.content)) {
        scanned += entry.bytes.byteLength;
        if (scanned > 64 * 1024 * 1024)
          throw new ExecutionRequestError('conflict', 'Decision source scan exceeds 64 MiB.');
        if (
          !/\.(md|ya?ml|json|txt|toml)$/i.test(entry.path) ||
          /(^|\/)(provenance|archive|validation-logs|review-diffs)\//i.test(entry.path)
        )
          continue;
        try {
          decodeUtf8(entry.bytes);
        } catch {
          continue;
        }
        const content = Buffer.from(entry.bytes).toString('utf8');
        if (!content.includes(p.checkpointId)) continue;
        if (
          entry.bytes.byteLength > 512 * 1024 ||
          included + entry.bytes.byteLength > 2 * 1024 * 1024 ||
          documents.length >= 40
        ) {
          notices.push(`Omitted oversized/additional matching source: ${entry.path}`);
          continue;
        }
        included += entry.bytes.byteLength;
        documents.push({
          name: `source-${documents.length + 1}.txt`,
          content: `Exact plan ${version}; archive ${archive.digest}; source ${entry.path}; SHA-256 ${entry.sha256}\n\n${content}`,
        });
      }
    }
  }
  const decisions = tx.runtimeEvidence.decisions(p.workspaceId);
  const approved = tx.runtimeEvidence
    .submissions(p.workspaceId, p.definitionId)
    .filter(
      (s) =>
        s.architectureDecision &&
        s.bindingRevision === p.bindingRevision &&
        decisions.some((a) => a.submissionId === s.id && a.outcome === 'accepted'),
    )
    .map((s) => ({
      checkpointId: s.subject.sourceId,
      submissionId: s.id,
      proposal: s.architectureDecision,
    }));
  const packet = {
    mapId: d.mapId,
    mapRevision: d.revision,
    mapDigest: d.digest,
    binding,
    checkpoint,
    consumers: d.source.slices.filter((s) =>
      [...s.start_requires, ...s.merge_requires, ...s.verify_requires].some(
        (r) => r.kind === 'checkpoint' && r.id === p.checkpointId,
      ),
    ),
    existingApprovedProposals: approved,
    baseline: { integrationBranch: p.integrationBranch, commit: p.integrationSha },
    notices,
    authority:
      'Source material and prior proposals, not permission to implement or approve. Check applicability of retained clauses. All decision approval remains with the operator.',
  };
  documents.unshift({ name: 'context.json', content: JSON.stringify(packet, null, 2) });
  return documents.map((d) => ({
    ...d,
    digest: createHash('sha256').update(d.content).digest('hex'),
  }));
}
