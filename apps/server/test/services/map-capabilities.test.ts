import { expect, it } from 'vitest';
import { mapCapabilities, type ConcurrencySource } from '@craftingtable/domain';
import { renamed, rewordedSource, v03Source } from '../map-rewording.js';

const source = v03Source();

it('recognizes the v0.3 map: plan acceptance by kind and owner, decisions, roles, resources and maturity', () => {
  const capabilities = mapCapabilities(source);
  expect(capabilities.planCheckpoint).toBe('STACK-PLAN-ACCEPTED');
  expect(capabilities.planAcceptance).toEqual({
    checkpointId: 'STACK-PLAN-ACCEPTED',
    reviewerRole: 'stack-integration-owner',
  });
  const decisions = source.checkpoints.filter((c) => c.kind === 'architecture_decision');
  expect(decisions).toHaveLength(58);
  expect(capabilities.architectureDecisions).toEqual(
    decisions.map((c) => ({ checkpointId: c.id, reviewerRole: 'repository-maintainer' })),
  );
  expect(capabilities.securityReviewerRole).toBe(
    'independent-security-reviewer-if-required-by-source',
  );
  expect(capabilities.operatorRecoverableProfile).toBe('contract-checkpoint');
  expect(capabilities.resources).toEqual([
    {
      resourceId: 'isolated-development-workspace',
      adapter: 'development-workspace',
      usable: true,
    },
    { resourceId: 'controlled-native-test-host', adapter: 'native-test-host', usable: true },
    { resourceId: 'kata-instance-test-host', usable: false },
  ]);
  // "independent/mixed" and "Independent classification; …" both lead with the token.
  expect(capabilities.independentWorkItems).toEqual([
    'wi/WI-01',
    'wi/WI-02',
    'wi/WI-03',
    'wi/WI-05',
    'wi/WI-10',
    'wi/WI-11',
    'wi/WI-12',
    'exo/EXO-01',
    'exo/EXO-02',
    'exo/EXO-04',
    'exo/EXO-05',
    'exo/EXO-07',
    'exo/EXO-08',
    'exo/EXO-09',
    'exo/EXO-14',
    'exo/EXO-17',
  ]);
  // Kata needs an externally managed host: the one thing this map asks for that no adapter runs.
  expect(capabilities.gaps).toEqual([
    { code: 'resource-adapter-missing', resourceId: 'kata-instance-test-host' },
  ]);
});

it('gives the same capabilities for a reworded copy of the map', () => {
  const reworded = rewordedSource(source);
  expect(reworded.checkpoints[0]!.title).not.toBe(source.checkpoints[0]!.title);
  expect(mapCapabilities(reworded)).toEqual(mapCapabilities(source));
});

it('finds the plan checkpoint by what it is, so renaming its id keeps plan acceptance', () => {
  const capabilities = mapCapabilities(renamed(source, 'STACK-PLAN-ACCEPTED', 'PLAN-OK'));
  expect(capabilities.planAcceptance).toEqual({
    checkpointId: 'PLAN-OK',
    reviewerRole: 'stack-integration-owner',
  });
  expect(capabilities.gaps).toEqual(mapCapabilities(source).gaps);
});

const plan = (s: ConcurrencySource) => s.checkpoints.find((c) => c.kind === 'plan_approval')!;
const withProfile = (
  s: ConcurrencySource,
  id: string,
  change: (p: ConcurrencySource['evidence_profiles'][number]) => object,
): ConcurrencySource => ({
  ...s,
  evidence_profiles: s.evidence_profiles.map((p) => (p.id === id ? { ...p, ...change(p) } : p)),
});

it('turns a reworded or re-roled plan contract into a typed gap, keeping the checkpoint', () => {
  const cases: [ConcurrencySource, string[]][] = [
    [
      withProfile(source, 'plan-approval', (p) => ({
        required_evidence: [...p.required_evidence.slice(1), 'approved map digest only'],
      })),
      ['required_evidence'],
    ],
    [renamed(source, 'stack-integration-owner', 'stack-owner'), ['reviewer_roles']],
    [
      {
        ...source,
        checkpoints: source.checkpoints.map((c) =>
          c.kind === 'plan_approval'
            ? { ...c, pass_criteria: [...c.pass_criteria.slice(1), 'Map is valid.'] }
            : c,
        ),
      },
      ['pass_criteria'],
    ],
  ];
  for (const [changed, fields] of cases) {
    const capabilities = mapCapabilities(changed);
    expect(capabilities.planCheckpoint).toBe('STACK-PLAN-ACCEPTED');
    expect(capabilities.planAcceptance).toBeUndefined();
    expect(capabilities.gaps).toContainEqual({
      code: 'plan-contract-changed',
      checkpointId: 'STACK-PLAN-ACCEPTED',
      fields,
    });
  }
  const foreign = mapCapabilities({
    ...source,
    checkpoints: source.checkpoints.map((c) =>
      c.kind === 'plan_approval' ? { ...c, owner: 'wi' } : c,
    ),
  });
  expect(foreign.planCheckpoint).toBeUndefined();
  expect(foreign.gaps).toContainEqual({
    code: 'plan-owner-unrecognized',
    checkpointId: 'STACK-PLAN-ACCEPTED',
    owner: 'wi',
  });
  const twice = { ...source, checkpoints: [...source.checkpoints, { ...plan(source), id: 'P2' }] };
  expect(mapCapabilities(twice).planCheckpoint).toBeUndefined();
  expect(mapCapabilities(twice).gaps).toContainEqual({
    code: 'plan-checkpoint-ambiguous',
    checkpointIds: ['STACK-PLAN-ACCEPTED', 'P2'],
  });
});

it('turns a changed decision-review contract into one typed gap per decision', () => {
  const decisions = source.checkpoints.filter((c) => c.kind === 'architecture_decision');
  for (const [changed, fields] of [
    [renamed(source, 'repository-maintainer', 'maintainer'), ['reviewer_roles']],
    [
      withProfile(source, 'decision-review', (p) => ({
        required_evidence: p.required_evidence.map((r) => `${r}.`),
      })),
      ['required_evidence'],
    ],
  ] as const) {
    const capabilities = mapCapabilities(changed);
    expect(capabilities.architectureDecisions).toEqual([]);
    expect(capabilities.gaps.filter((g) => g.code === 'decision-contract-changed')).toEqual(
      decisions.map((c) => ({
        code: 'decision-contract-changed',
        checkpointId: c.id,
        profileId: 'decision-review',
        fields,
      })),
    );
  }
});

it('turns a renamed security role, recovery profile or resource id into a typed gap', () => {
  const security = mapCapabilities(
    renamed(source, 'independent-security-reviewer-if-required-by-source', 'security-reviewer'),
  );
  expect(security.securityReviewerRole).toBeUndefined();
  expect(security.gaps).toContainEqual({ code: 'security-role-undeclared' });

  const recovery = mapCapabilities(renamed(source, 'contract-checkpoint', 'contract-review'));
  expect(recovery.operatorRecoverableProfile).toBeUndefined();
  expect(recovery.gaps).toContainEqual({
    code: 'recovery-profile-unrecognized',
    checkpointIds: source.checkpoints.filter((c) => c.kind === 'contract').map((c) => c.id),
  });

  const native = mapCapabilities(renamed(source, 'controlled-native-test-host', 'native-host'));
  expect(native.resources.find((r) => r.resourceId === 'native-host')).toEqual({
    resourceId: 'native-host',
    usable: false,
  });
  expect(native.gaps).toContainEqual({
    code: 'resource-adapter-missing',
    resourceId: 'native-host',
  });

  const shared = mapCapabilities({
    ...source,
    resource_profiles: source.resource_profiles.map((p) =>
      p.id === 'isolated-development-workspace'
        ? { ...p, fixture_authorization_required: true }
        : p,
    ),
  });
  expect(shared.gaps).toContainEqual({
    code: 'resource-adapter-unusable',
    resourceId: 'isolated-development-workspace',
    adapter: 'development-workspace',
    fields: ['fixture_authorization_required'],
  });
});

it('classifies maturity by its leading word only', () => {
  const changed = mapCapabilities({
    ...source,
    work_items: source.work_items.map((w) =>
      w.id === 'wi/WI-01' ? { ...w, source_maturity: 'Mostly independent' } : w,
    ),
  });
  expect(changed.independentWorkItems).not.toContain('wi/WI-01');
  expect(changed.independentWorkItems).toHaveLength(15);
});

it('checks every field of the attested contracts, a duplicated obligation included', () => {
  const planId = 'STACK-PLAN-ACCEPTED';
  const decision = source.checkpoints.find((c) => c.kind === 'architecture_decision')!;
  const planGap = (s: ConcurrencySource) =>
    mapCapabilities(s).gaps.find((g) => g.code === 'plan-contract-changed');
  const decisionGap = (s: ConcurrencySource) =>
    mapCapabilities(s).gaps.find(
      (g) => g.code === 'decision-contract-changed' && g.checkpointId === decision.id,
    );
  const caseFor = (checkpoint: string) => ({ ...source.acceptance_coverage[0]!, checkpoint });
  // A duplicate in place of a missing obligation keeps the length but changes the contract.
  expect(
    planGap(
      withProfile(source, 'plan-approval', (p) => ({
        required_evidence: [...p.required_evidence.slice(0, 3), p.required_evidence[0]!],
      })),
    ),
  ).toMatchObject({ fields: ['required_evidence'] });
  expect(
    decisionGap(
      withProfile(source, 'decision-review', (p) => ({
        required_evidence: [...p.required_evidence.slice(0, 2), p.required_evidence[0]!],
      })),
    ),
  ).toMatchObject({ fields: ['required_evidence'] });
  expect(
    planGap({
      ...source,
      checkpoints: source.checkpoints.map((c) =>
        c.id === planId
          ? {
              ...c,
              requires: [
                { kind: 'work_item' as const, id: 'wi/WI-01', state: 'accepted' as const },
              ],
            }
          : c,
      ),
    }),
  ).toMatchObject({ fields: ['requires'] });
  expect(
    planGap({ ...source, acceptance_coverage: [...source.acceptance_coverage, caseFor(planId)] }),
  ).toMatchObject({ fields: ['acceptance_coverage'] });
  expect(
    decisionGap(withProfile(source, 'decision-review', () => ({ independence_required: false }))),
  ).toMatchObject({ fields: ['independence_required'] });
  expect(
    decisionGap({
      ...source,
      acceptance_coverage: [...source.acceptance_coverage, caseFor(decision.id)],
    }),
  ).toMatchObject({ fields: ['acceptance_coverage'] });
});
