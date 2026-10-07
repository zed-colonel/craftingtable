import { nativeHostDigest } from '@craftingtable/agents';
import type {
  ConcurrencyDefinition,
  ConcurrencySource,
  ExecutionPhase,
  ExecutionScope,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { expect, it } from 'vitest';
import { supportsArchitectureDecision } from '../../src/services/architecture-decision-policy.js';
import { buildVerificationPolicy } from '../../src/services/build-verification-policy.js';
import type { ResolvedScope } from '../../src/services/execution-scope.js';
import { needsNativeVerification } from '../../src/services/native-verification-policy.js';
import { phaseResources } from '../../src/services/phase-resources.js';
import { planCheckpoint, supportsPlanEvidence } from '../../src/services/plan-acceptance-policy.js';
import { supportsTechnicalCheckpoint } from '../../src/services/technical-checkpoint-policy.js';
import { renamed, rewordedSource, v03Source } from '../map-rewording.js';

const source = v03Source();
const definition = (s: ConcurrencySource) =>
  ({ id: 'definition', workspaceId: 'ws', source: s }) as unknown as ConcurrencyDefinition;

/** Just what `phaseResources` reads: capacities, and an approved native host or none. */
function storage(nativeApproved: boolean) {
  const generation = { id: 'runtime', pins: [], environments: [] };
  return {
    phaseScheduling: { capacity: (key: string) => (key === 'local-verification' ? 1 : 2) },
    runtimeEvidence: {
      nativeApprovals: () =>
        nativeApproved
          ? [{ approved: true, runtimeId: 'runtime', hostDigest: nativeHostDigest() }]
          : [],
      generations: () => [generation],
    },
    execution: {
      sourceRepositories: { find: () => ({ rootPath: '/repositories/wi' }) },
    },
  } as unknown as StorageRepositories;
}

const PHASES: ExecutionPhase[] = ['start', 'merge', 'verify', 'accept'];
/** Every answer the done-when names, for every scope of a map. */
function answers(s: ConcurrencySource) {
  const d = definition(s);
  const scope = (kind: ExecutionScope['kind'], sourceId: string): ExecutionScope => ({
    kind,
    sourceId,
    definitionId: d.id,
    bindingRevision: 1,
  });
  const scopes = [
    ...s.slices.flatMap((x) => [scope('slice', x.id), scope('slice-verification', x.id)]),
    ...s.work_items.map((w) => scope('parent-acceptance', w.id)),
  ];
  return {
    builds: scopes.map((x) => buildVerificationPolicy(d, x)),
    native: scopes.map((x) => needsNativeVerification(d, x)),
    technical: s.checkpoints.map((c) => supportsTechnicalCheckpoint(d, c.id)),
    resources: [false, true].flatMap((approved) =>
      s.slices.flatMap((slice) =>
        PHASES.map((phase) =>
          phaseResources(
            storage(approved),
            {
              definition: d,
              slice,
              scope: scope('slice', slice.id),
              item: { workspaceId: 'ws' },
              binding: { alias: 'wi', repositoryId: 'repo', integrationBranch: 'main' },
            } as unknown as ResolvedScope,
            phase,
          ),
        ),
      ),
    ),
  };
}

it('answers every policy question for every scope identically for a reworded copy of the map', () => {
  const original = answers(source);
  // The comparison has something to compare: scoped builds, native verification, technical
  // checkpoints, admitted resources and blockers all occur in the map.
  expect(original.builds.some((b) => b.mode === 'scoped-checks')).toBe(true);
  expect(original.native.some(Boolean)).toBe(true);
  expect(original.technical.some(Boolean)).toBe(true);
  expect(original.resources.some((r) => r.blockers.length)).toBe(true);
  expect(original.resources.some((r) => r.resources.length)).toBe(true);
  expect(answers(rewordedSource(source))).toEqual(original);
});

it('keeps generated plan evidence for a renamed plan checkpoint, found by kind and owner', () => {
  const d = definition(renamed(source, 'STACK-PLAN-ACCEPTED', 'PLAN-OK'));
  expect(planCheckpoint(d)).toBe('PLAN-OK');
  expect(supportsPlanEvidence(d)).toBe(true);
});

it('falls back to manual evidence when an attested contract is reworded or a role renamed', () => {
  const reworded = definition({
    ...source,
    evidence_profiles: source.evidence_profiles.map((p) =>
      p.id === 'plan-approval'
        ? { ...p, required_evidence: p.required_evidence.map((r) => `${r}.`) }
        : p,
    ),
  });
  // The plan checkpoint is still the plan checkpoint; only its generator is unavailable.
  expect(planCheckpoint(reworded)).toBe('STACK-PLAN-ACCEPTED');
  expect(supportsPlanEvidence(reworded)).toBe(false);
  expect(supportsPlanEvidence(definition(source))).toBe(true);

  const decision = source.checkpoints.find((c) => c.kind === 'architecture_decision')!.id;
  expect(supportsArchitectureDecision(definition(source), decision)).toBe(true);
  expect(
    supportsArchitectureDecision(
      definition(renamed(source, 'repository-maintainer', 'maintainer')),
      decision,
    ),
  ).toBe(false);
});

it('blocks a renamed native resource as unsupported, leaving externally reviewed evidence', () => {
  const s = renamed(source, 'controlled-native-test-host', 'native-host');
  const slice = s.slices.find((x) => x.resources_by_phase.verify.includes('native-host'))!;
  const scope: ExecutionScope = {
    kind: 'slice',
    sourceId: slice.id,
    definitionId: 'definition',
    bindingRevision: 1,
  };
  expect(needsNativeVerification(definition(s), scope)).toBe(false);
  const { blockers } = phaseResources(
    storage(true),
    { definition: definition(s), slice, scope, item: { workspaceId: 'ws' } } as never,
    'verify',
  );
  expect(blockers).toEqual([
    expect.objectContaining({ code: 'resource-unsupported', refs: { resourceKey: 'native-host' } }),
  ]);
});
