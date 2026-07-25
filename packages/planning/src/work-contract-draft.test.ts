import {
  asPlanVersionId,
  asProjectId,
  asWorkItemId,
  WORK_CONTRACT_UNRESOLVED_FIELDS,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { analyzePlanBundle } from './bundle.js';
import type { NormalizedWorkItem } from './normalize.js';
import { aqBundleArtifacts } from './test-support.js';
import { projectWorkContractDraft } from './work-contract-draft.js';

/** CT03-A57 and CT03-A58: draft projection fidelity and non-executability. */

const analysis = analyzePlanBundle({ artifacts: aqBundleArtifacts() });

function fixtureItem(sourceId: string): NormalizedWorkItem {
  const item = analysis.plan?.workItems.find((candidate) => candidate.sourceId === sourceId);
  if (item === undefined) {
    throw new Error(`${sourceId} is missing from the AQ fixture`);
  }
  return item;
}

const draft = projectWorkContractDraft({
  projectId: asProjectId('project-1'),
  planVersionId: asPlanVersionId('version-1'),
  workItemId: asWorkItemId('item-1'),
  item: fixtureItem('AQ-01'),
  requiredDependencies: [],
  recommendedDependencies: [],
});

describe('work-contract draft projection', () => {
  it('inherits objective, exit gate, risk, and areas from the source item (CT03-A57)', () => {
    expect(draft.objective).toEqual({
      title: 'Freeze evidence and establish the development contract',
      exitGate: 'Baseline green; contract, archive, and boundary checks installed.',
    });
    expect(draft.classification).toEqual({
      risk: 'medium',
      primaryAreas: ['contract', 'conformance', 'archive'],
    });
    expect(draft.source).toEqual({
      projectId: 'project-1',
      planVersionId: 'version-1',
      workItemId: 'item-1',
      sourceWorkItemId: 'AQ-01',
    });
  });

  it('carries resolved dependency references with their statuses (CT03-A57)', () => {
    const withDependencies = projectWorkContractDraft({
      projectId: asProjectId('project-1'),
      planVersionId: asPlanVersionId('version-1'),
      workItemId: asWorkItemId('item-2'),
      item: fixtureItem('AQ-08'),
      requiredDependencies: [
        {
          sourceId: 'AQ-04',
          title: 'Implement compound idempotent task admission',
          status: 'proposed',
        },
      ],
      recommendedDependencies: [
        { sourceId: 'AQ-05', title: 'Add durable signal admission', status: 'admitted' },
      ],
    });
    expect(withDependencies.dependencies.required).toEqual([
      {
        sourceId: 'AQ-04',
        title: 'Implement compound idempotent task admission',
        status: 'proposed',
        kind: 'required',
      },
    ]);
    expect(withDependencies.dependencies.recommended).toEqual([
      {
        sourceId: 'AQ-05',
        title: 'Add durable signal admission',
        status: 'admitted',
        kind: 'recommended',
      },
    ]);
  });

  it('is explicitly draft, incomplete, and human-merge-required (CT03-A58)', () => {
    expect(draft.schemaVersion).toBe(1);
    expect(draft.status).toBe('draft');
    expect(draft.completeness).toBe('incomplete');
    expect(draft.merge).toEqual({ humanAuthorizationRequired: true });
  });

  it('names every unresolved field rather than leaving it blank (CT03-A58)', () => {
    expect(draft.missing).toEqual([...WORK_CONTRACT_UNRESOLVED_FIELDS]);
    expect(draft.missing).toEqual([
      'registered-repository',
      'exact-base-revision',
      'path-scope',
      'verification-policy',
      'protected-acceptance-criteria',
      'agent-backend',
      'execution-environment',
    ]);
    expect(draft.repository.status).toBe('unresolved');
    expect(draft.baseRevision.status).toBe('unresolved');
    expect(draft.scope.status).toBe('unresolved');
    expect(draft.verification.status).toBe('unresolved');
  });

  it('carries no field that could be read as authorization (CT03-I11)', () => {
    const keys = new Set(Object.keys(draft));
    for (const forbidden of ['approved', 'executable', 'ready', 'authorized', 'active']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toMatch(/"approved"/);
    expect(serialized).not.toMatch(/"executable"/);
  });

  it('records the bounded review defaults without executing anything', () => {
    expect(draft.review).toEqual({
      requiredPerspectives: ['specification', 'correctness'],
      maxRemediationGenerations: 3,
    });
    expect(draft.verification.checkIds).toEqual([]);
    expect(draft.scope.writable).toEqual([]);
    expect(draft.scope.forbidden).toEqual([]);
  });
});
