import type { ConcurrencySource } from './concurrency-source.js';
import {
  asCheckpointId,
  asEvidenceProfileId,
  asMapResourceId,
  type CheckpointId,
  type EvidenceProfileId,
  type MapResourceId,
} from './ids.js';

type Checkpoint = ConcurrencySource['checkpoints'][number];
type EvidenceProfile = ConcurrencySource['evidence_profiles'][number];

/**
 * The v0.3 map vocabulary the controller recognizes (R-F2, FMT-04, CTRL-21): the reviewer
 * roles, resource ids, profile id, maturity token and attested contract wording it gives a
 * meaning to. They are written here and nowhere else in production code (the scope check's
 * map-vocabulary rule); every other module asks `mapCapabilities` what a map declares.
 *
 * The wording of the two attested contracts is matched exactly on purpose (operator decision
 * 2026-10-06): the daemon attests plan acceptance and prepares decision reviews only for the
 * obligations it knows, and a reworded obligation falls back to independently reviewed
 * evidence as a typed gap, never to a silent attestation of something it did not check.
 * Everything else in a map (titles, notes, other profiles' wording) carries no behaviour.
 */
export const V03_VOCABULARY = {
  /** What the saved-plan generator attests (ADR-050), and who accepts it. */
  planAcceptance: {
    requiredEvidence: [
      'approved map digest and all three exact source archive/source-file digests',
      'exact WI/EXO application project/plan-version bindings and the immutable implemented AQ source/build dependency binding',
      'approval of CS-D01 through CS-D18, or a separately versioned replacement definition',
      'configured independent reviewers, version/evidence bindings, target selection, and resources',
    ],
    passCriteria: [
      'Map structure is valid, source hashes match, and the expanded state graph is acyclic.',
      'All draft decisions are explicitly approved for this map digest.',
      'Application resolves exact project/plan-version bindings atomically; missing bindings fail closed.',
    ],
    reviewerRole: 'stack-integration-owner',
  },
  /** The decision-owner review an architecture decision is prepared for; never a test gate. */
  decisionReview: {
    requiredEvidence: [
      'accepted decision artifact digest and revision',
      'source contract and affected schema or protocol references',
      'decision owner approval and applicability to the active plan generation',
    ],
    reviewerRole: 'repository-maintainer',
  },
  /** The reviewer a source-required security review is delegated to. */
  securityReviewerRole: 'independent-security-reviewer-if-required-by-source',
  /** The resources the daemon manages itself, by the adapter that runs them. */
  resourceAdapters: {
    developmentWorkspace: 'isolated-development-workspace',
    nativeTestHost: 'controlled-native-test-host',
  },
  /** Contract checkpoints the operator may recover without a delegated review. */
  operatorRecoverableProfile: 'contract-checkpoint',
  /** A parent whose source maturity starts with this word may build with scoped checks (ADR-053). */
  independentMaturity: /^independent\b/i,
} as const;

/** How the daemon runs a resource it manages. */
type ResourceAdapter = 'development-workspace' | 'native-test-host';

/** A plan-acceptance contract field that differs from the attested one. */
type PlanContractField =
  | 'requires'
  | 'evidence_profile'
  | 'required_evidence'
  | 'pass_criteria'
  | 'reviewer_roles'
  | 'acceptance_coverage';
/** A decision-review contract field that differs from the known one. */
type DecisionContractField =
  | 'evidence_profile'
  | 'independence_required'
  | 'required_evidence'
  | 'reviewer_roles'
  | 'acceptance_coverage';
/** A resource profile field that keeps its adapter from running it. */
type ResourceProfileField =
  | 'resource_profile'
  | 'requires_hardware_virtualization'
  | 'fixture_authorization_required';

/**
 * Something a map declares that the controller cannot automate, and so leaves to
 * independently reviewed evidence or the operator. Typed: readers branch on `code`.
 */
export type MapCapabilityGap =
  /** More than one stack-owned plan approval: none is taken as the plan checkpoint. */
  | { readonly code: 'plan-checkpoint-ambiguous'; readonly checkpointIds: readonly CheckpointId[] }
  /** A plan approval the stack does not own: it is not taken as the plan checkpoint. */
  | {
      readonly code: 'plan-owner-unrecognized';
      readonly checkpointId: CheckpointId;
      readonly owner: string;
    }
  /** The plan checkpoint's contract is not the one the generator attests. */
  | {
      readonly code: 'plan-contract-changed';
      readonly checkpointId: CheckpointId;
      readonly fields: readonly PlanContractField[];
    }
  /** An architecture decision whose review contract is not the decision-owner one. */
  | {
      readonly code: 'decision-contract-changed';
      readonly checkpointId: CheckpointId;
      readonly profileId: EvidenceProfileId;
      readonly fields: readonly DecisionContractField[];
    }
  /** No evidence profile names the security reviewer, so no roadmap can delegate that review. */
  | { readonly code: 'security-role-undeclared' }
  /** Contract checkpoints the operator cannot recover without a delegated review. */
  | {
      readonly code: 'recovery-profile-unrecognized';
      readonly checkpointIds: readonly CheckpointId[];
    }
  /** A resource no daemon adapter runs. */
  | { readonly code: 'resource-adapter-missing'; readonly resourceId: MapResourceId }
  /** A resource whose adapter is known but whose profile asks for what it cannot provide. */
  | {
      readonly code: 'resource-adapter-unusable';
      readonly resourceId: MapResourceId;
      readonly adapter: ResourceAdapter;
      readonly fields: readonly ResourceProfileField[];
    };

interface MapResourceCapability {
  readonly resourceId: MapResourceId;
  /** The adapter for this id, whatever the profile declares. */
  readonly adapter?: ResourceAdapter;
  /** Whether the declared profile lets the adapter run it. */
  readonly usable: boolean;
}

/** What the controller can automate for a map, and what it cannot (R-F2). */
interface MapCapabilities {
  /** The plan checkpoint: the single plan approval the stack owns, whatever its id. */
  readonly planCheckpoint?: CheckpointId;
  /** Present when the plan checkpoint's contract is the one the generator attests. */
  readonly planAcceptance?: { readonly checkpointId: CheckpointId; readonly reviewerRole: string };
  /** Architecture decisions whose review contract is the decision-owner one. */
  readonly architectureDecisions: readonly {
    readonly checkpointId: CheckpointId;
    readonly reviewerRole: string;
  }[];
  /** The security reviewer role, when an evidence profile names it. */
  readonly securityReviewerRole?: string;
  /** The evidence profile of operator-recoverable contract checkpoints, when declared. */
  readonly operatorRecoverableProfile?: string;
  /** Every resource a profile declares or a slice uses, in first-seen order. */
  readonly resources: readonly MapResourceCapability[];
  /** Parents whose source maturity classifies them as independent (ADR-053). */
  readonly independentWorkItems: readonly string[];
  readonly gaps: readonly MapCapabilityGap[];
}

/** The same members, each once, in any order. */
function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && new Set(a).size === a.length && a.every((v) => b.includes(v));
}
function coveredByAcceptance(s: ConcurrencySource, id: string) {
  return (
    s.acceptance_coverage.some((x) => x.checkpoint === id) ||
    s.baseline_acceptance_coverage.some((x) => x.capability_gate === id)
  );
}

function planContract(
  s: ConcurrencySource,
  c: Checkpoint,
  p: EvidenceProfile | undefined,
): PlanContractField[] {
  const known = V03_VOCABULARY.planAcceptance;
  const fields: PlanContractField[] = [];
  if (c.requires.length) fields.push('requires');
  if (!p) fields.push('evidence_profile');
  else {
    if (!sameSet(p.required_evidence, known.requiredEvidence)) fields.push('required_evidence');
    if (!sameSet(p.reviewer_roles, [known.reviewerRole])) fields.push('reviewer_roles');
  }
  if (!sameSet(c.pass_criteria, known.passCriteria)) fields.push('pass_criteria');
  if (coveredByAcceptance(s, c.id)) fields.push('acceptance_coverage');
  return fields;
}

function decisionContract(
  s: ConcurrencySource,
  c: Checkpoint,
  p: EvidenceProfile | undefined,
): DecisionContractField[] {
  const known = V03_VOCABULARY.decisionReview;
  const fields: DecisionContractField[] = [];
  if (!p) fields.push('evidence_profile');
  else {
    if (!p.independence_required) fields.push('independence_required');
    if (!sameSet(p.required_evidence, known.requiredEvidence)) fields.push('required_evidence');
    if (!sameSet(p.reviewer_roles, [known.reviewerRole])) fields.push('reviewer_roles');
  }
  if (coveredByAcceptance(s, c.id)) fields.push('acceptance_coverage');
  return fields;
}

function evaluate(s: ConcurrencySource): MapCapabilities {
  const gaps: MapCapabilityGap[] = [];
  const profile = (id: string) => s.evidence_profiles.find((p) => p.id === id);

  // The plan checkpoint is found by what it is, so its id carries no meaning.
  const plans = s.checkpoints.filter((c) => c.kind === 'plan_approval' && c.owner === 'stack');
  for (const c of s.checkpoints.filter((c) => c.kind === 'plan_approval' && c.owner !== 'stack'))
    gaps.push({
      code: 'plan-owner-unrecognized',
      checkpointId: asCheckpointId(c.id),
      owner: c.owner,
    });
  if (plans.length > 1)
    gaps.push({
      code: 'plan-checkpoint-ambiguous',
      checkpointIds: plans.map((c) => asCheckpointId(c.id)),
    });
  const plan = plans.length === 1 ? plans[0] : undefined;
  const planFields = plan ? planContract(s, plan, profile(plan.evidence_profile)) : [];
  if (plan && planFields.length)
    gaps.push({
      code: 'plan-contract-changed',
      checkpointId: asCheckpointId(plan.id),
      fields: planFields,
    });

  const architectureDecisions: MapCapabilities['architectureDecisions'][number][] = [];
  for (const c of s.checkpoints.filter((c) => c.kind === 'architecture_decision')) {
    const fields = decisionContract(s, c, profile(c.evidence_profile));
    if (fields.length)
      gaps.push({
        code: 'decision-contract-changed',
        checkpointId: asCheckpointId(c.id),
        profileId: asEvidenceProfileId(c.evidence_profile),
        fields,
      });
    else
      architectureDecisions.push({
        checkpointId: asCheckpointId(c.id),
        reviewerRole: V03_VOCABULARY.decisionReview.reviewerRole,
      });
  }

  const security = s.evidence_profiles.some((p) =>
    p.reviewer_roles.includes(V03_VOCABULARY.securityReviewerRole),
  );
  if (!security) gaps.push({ code: 'security-role-undeclared' });

  const recoverable = profile(V03_VOCABULARY.operatorRecoverableProfile)?.id;
  const unrecoverable = s.checkpoints
    .filter((c) => c.kind === 'contract' && c.evidence_profile !== recoverable)
    .map((c) => asCheckpointId(c.id));
  if (unrecoverable.length)
    gaps.push({ code: 'recovery-profile-unrecognized', checkpointIds: unrecoverable });

  const { developmentWorkspace, nativeTestHost } = V03_VOCABULARY.resourceAdapters;
  const resources: MapResourceCapability[] = [];
  const ids = [
    ...new Set([
      ...s.resource_profiles.map((p) => p.id),
      ...s.slices.flatMap((x) => [
        ...x.resources_by_phase.start,
        ...x.resources_by_phase.merge,
        ...x.resources_by_phase.verify,
      ]),
    ]),
  ];
  for (const id of ids) {
    const resourceId = asMapResourceId(id);
    const p = s.resource_profiles.find((p) => p.id === resourceId);
    const adapter: ResourceAdapter | undefined =
      resourceId === developmentWorkspace
        ? 'development-workspace'
        : resourceId === nativeTestHost
          ? 'native-test-host'
          : undefined;
    if (!adapter) {
      resources.push({ resourceId, usable: false });
      gaps.push({ code: 'resource-adapter-missing', resourceId });
      continue;
    }
    // A native host is operator-approved fixture authority; a development workspace needs none.
    const fields: ResourceProfileField[] = !p
      ? ['resource_profile']
      : [
          ...(p.requires_hardware_virtualization
            ? (['requires_hardware_virtualization'] as const)
            : []),
          ...(adapter === 'development-workspace' && p.fixture_authorization_required
            ? (['fixture_authorization_required'] as const)
            : []),
        ];
    resources.push({ resourceId, adapter, usable: !fields.length });
    if (fields.length)
      gaps.push({ code: 'resource-adapter-unusable', resourceId, adapter, fields });
  }

  return {
    ...(plan ? { planCheckpoint: asCheckpointId(plan.id) } : {}),
    ...(plan && !planFields.length
      ? {
          planAcceptance: {
            checkpointId: asCheckpointId(plan.id),
            reviewerRole: V03_VOCABULARY.planAcceptance.reviewerRole,
          },
        }
      : {}),
    architectureDecisions,
    ...(security ? { securityReviewerRole: V03_VOCABULARY.securityReviewerRole } : {}),
    ...(recoverable ? { operatorRecoverableProfile: recoverable } : {}),
    resources,
    independentWorkItems: s.work_items
      .filter((w) => V03_VOCABULARY.independentMaturity.test(w.source_maturity))
      .map((w) => w.id),
    gaps,
  };
}

/**
 * Per map source object, which is never mutated: evaluated once however often one read asks
 * (R-H4). Each storage read parses a new object, which is evaluated afresh (about half a
 * millisecond for the v0.3 map, half its parse).
 */
const capabilitiesBySource = new WeakMap<ConcurrencySource, MapCapabilities>();

/**
 * What the controller recognizes in a map, as typed results, and what it does not, as typed
 * gaps (R-F2). Pure: it reads only the source, so a reworded title, note or unattested
 * profile changes nothing here, while a reworded attested contract, or a renamed role, profile
 * or resource id, becomes a gap and its feature falls back to manual evidence.
 */
export function mapCapabilities(s: ConcurrencySource): MapCapabilities {
  const known = capabilitiesBySource.get(s);
  if (known) return known;
  const evaluated = evaluate(s);
  capabilitiesBySource.set(s, evaluated);
  return evaluated;
}

/** The adapter and usability of a resource id, or undefined for an id nothing declares or uses. */
export function mapResource(
  s: ConcurrencySource,
  resourceId: string,
): MapResourceCapability | undefined {
  return mapCapabilities(s).resources.find((r) => r.resourceId === resourceId);
}

/** Whether a parent's source maturity classifies it as independent (ADR-053). */
export function independentWorkItem(s: ConcurrencySource, workItemId: string): boolean {
  return mapCapabilities(s).independentWorkItems.includes(workItemId);
}
