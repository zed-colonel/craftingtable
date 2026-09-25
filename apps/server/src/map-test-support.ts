import type { ConcurrencySource, JsonValue } from '@craftingtable/domain';
import { sha256Hex, sourceRecordDigest } from '@craftingtable/planning';
import { zipFixture } from '../../../packages/planning/src/archive-test-support.js';

/**
 * A minimal v0.3 concurrency map for execution tests, built so the real importer accepts it
 * (R-F3, FMT-15). Tests describe the local part of a map: one planned repository `local`,
 * its work items, slices and checkpoints. `sealLocalMap` then adds what every v0.3 package
 * carries and a test should not have to spell out: an implemented upstream with its baseline
 * binding and lock, a second planned repository (the format needs two merge lanes), the
 * source snapshots the map claims to derive from, their digests and a previous definition.
 * Sealing never repairs what a test wrote: an unknown reference, a cycle or a missing
 * requirement still fails the import, as it would for an operator.
 *
 * The fixtures store the imported map without the two scaffolding repositories
 * (`withoutScaffolding`). With an implemented upstream in the map, every consumer must pin it
 * and every scoped run goes through the pinned Cargo build, which would move every scope test
 * onto that path (operator decision 2026-09-24). The stored map still conforms to the v0.3
 * schema, which test cleanup checks; the cross-stack rules it no longer meets wait for R-F5's
 * single-repository profile.
 */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Repository = ConcurrencySource['repositories'][number];
type Checkpoint = ConcurrencySource['checkpoints'][number];

export const LOCAL_MAP_ROOT = 'local-scope-map/';
const UPSTREAM = 'base';
const PEER = 'peer';
const BASELINE_ACCEPTED = 'BASE-ACCEPTED';
const BASELINE_PUBLISHED = 'BASE-PUBLISHED';
const PLAN_LINES = 200;

const repository = (id: string, role: Repository['role']): Repository => ({
  id,
  repository: `fixtures/${id}`,
  contract: `${id.toUpperCase()}-CONTRACT`,
  planning_profile: `${id.toUpperCase()}-PLAN-1`,
  target_branch: role === 'planned_application' ? 'main' : null,
  source_baseline_commit: null,
  source_plan: `${id}-plan`,
  source_work_breakdown: `${id}-work-breakdown`,
  source_stack_label: 'LOCAL-STACK-1',
  merge_lock: role === 'planned_application' ? `${id}-target-branch` : null,
  runtime_revision_status: role === 'planned_application' ? 'unbound' : 'source-archive-pinned',
  artifact_revision: `${id}-r1`,
  supplement_sources: [],
  role,
});

const checkpoint = (
  id: string,
  fields: Partial<Checkpoint> & Pick<Checkpoint, 'kind' | 'owner'>,
): Checkpoint => ({
  id,
  title: id,
  requires: [],
  evidence_profile: 'scope-review',
  pass_criteria: [`${id} reviewed`],
  source_refs: [],
  status_on_import: 'unresolved',
  invalidation: 'active-pin-or-evidence-change',
  decision_refs: [],
  ...fields,
});

const slice = (id: string): ConcurrencySource['slices'][number] => ({
  id,
  work_item: 'local/AQ-01',
  title: id,
  mode: 'implementation',
  scope: `Complete ${id}`,
  excludes: ['Other slice work'],
  start_requires: [],
  merge_requires: [],
  verify_requires: [],
  evidence_profile: 'scope-review',
  merge_lock: 'local-target-branch',
  workspace_policy: 'isolated-worktree-and-test-state',
  early_start_exception: false,
  source_refs: [{ source_id: 'local-plan', section: 'AQ-01' }],
  decision_refs: [],
  grants_effect_authority: false,
  partial_scope: 'full',
  // The one resource the daemon manages itself; others need an operator-bound environment.
  resources_by_phase: {
    start: ['isolated-development-workspace'],
    merge: ['isolated-development-workspace'],
    verify: ['isolated-development-workspace'],
  },
  planning_target_class: 'foundation',
  aq_baseline_case_ids: [],
});

export const LOCAL_SLICES = ['local/AQ-01/a', 'local/AQ-01/b'] as const;

/**
 * The local map every scope fixture starts from: `local/AQ-01` with two slices. Its one
 * source-profile case, CASE-PARENT, is owned by the parent and produced by slice a, since the
 * format requires at least one case and a producer the owner waits for.
 */
export function localScopeSource(): ConcurrencySource {
  return {
    $schema: 'cross-stack-concurrency-map.schema.json',
    document: 'Local scope fixture map',
    kind: 'cross_stack_concurrency_map',
    schema_version: '0.3.0',
    map_id: 'local-scope-fixture',
    revision: '0.3.0',
    status: 'draft',
    created_date: '2026-09-24',
    automatic_activation: false,
    source_files: [],
    repositories: [repository('local', 'planned_application')],
    decisions: [
      {
        id: 'CS-D01',
        title: 'Ordering versus dependency edges',
        proposed_resolution: 'Use source depends_on edges; do not infer edges from display order.',
        source_notes: ['Local plan §1'],
        status: 'proposed_requires_approval',
      },
    ],
    semantics: {
      requirement_operator: 'all_of',
      missing_or_stale_evidence: 'blocked',
      parent_acceptance: 'all original dependencies accepted AND all own slices verified',
      slice_lifecycle: ['started', 'merged', 'verified'],
      merge_inherits_start_requirements: true,
      verification_inherits_merge_requirements: true,
      start_does_not_authorize_external_effects: true,
      checkpoint_prerequisites_do_not_auto_pass_checkpoint: true,
      planning_order_is_not_a_dependency: true,
      source_critical_path_arrays_are_not_executable_edges: true,
      historical_evidence_is_immutable: true,
      validity_is_scoped_to_active_pin_bindings: true,
      runtime_state_is_separate_from_definition: true,
      generation_changed_midflight: 'revalidate_before_merge_verify_or_accept',
      unknown_references: 'reject_entire_import',
      dependency_cycle: 'reject_entire_import',
      unsupported_required_semantics: 'reject_entire_import',
      partial_runtime_slices_require_explicit_scope: true,
      profile_milestones_do_not_accept_parents: true,
      source_case_owners_are_not_dependencies: true,
      resource_availability_is_not_evidence: true,
      source_hashes_are_not_runtime_evidence: true,
      partial_core_is_not_full_upstream_gate: true,
      implemented_upstream_is_not_runnable: true,
      baseline_acceptance_is_not_publication: true,
      baseline_case_receipts_required: true,
    },
    evidence_profiles: [
      {
        id: 'scope-review',
        required_evidence: ['Tests passed'],
        reviewer_roles: ['independent-reviewer'],
        independence_required: true,
      },
      {
        id: 'work-item-exit',
        required_evidence: ['Original plan conforms'],
        reviewer_roles: ['independent-reviewer'],
        independence_required: true,
      },
    ],
    scheduling_policy: {
      mode: 'eligibility_not_a_calendar',
      no_duration_or_speedup_estimates: true,
      agent_capacity: 'required_application_configuration_not_assumed',
      resource_reservations: 'acquire_all_atomically_in_stable_order_only_after_dependencies_pass',
      hold_merge_lock_while_waiting_for_checkpoint: false,
      recheck_before_merge: true,
      required_execution_isolation: 'unique worktree and test state per concurrent run',
      priority_hint: 'Prefer work that unblocks the most consumers.',
      feedback_is_not_dependency: 'Feedback does not create dependencies.',
      suggested_focus_target: 'LOCAL',
      target_selection: 'Explicit application binding.',
      resource_profile_binding: 'Resource declarations are unsatisfied until operator-bound.',
    },
    resource_locks: [],
    checkpoints: [
      checkpoint('LOCAL-CASES', {
        kind: 'integration_evidence',
        owner: 'local',
        pass_criteria: ['Local case evidence reviewed'],
      }),
    ],
    deferred_decisions: [],
    work_items: [
      {
        id: 'local/AQ-01',
        repository: 'local',
        source_item_id: 'AQ-01',
        planning_order: 1,
        title: 'Freeze evidence and establish the target development contract',
        source_record_sha256: '',
        source_maturity: 'Independent',
        depends_on: [],
        primary_areas: ['root'],
        risk: 'medium',
        source_exit_gate: 'Queue accepts and drains one job.',
        source_test_reference: {
          source_id: 'local-plan',
          section: 'AQ-01',
          start_line: 1,
          end_line: 2,
        },
        required_slices: [...LOCAL_SLICES],
        acceptance_requires: LOCAL_SLICES.map((id) => ({ kind: 'slice', id, state: 'verified' })),
        acceptance_evidence_profile: 'work-item-exit',
        source_profile_case_ids: ['CASE-PARENT'],
        profile_evidence_slices: [],
        aq_baseline_case_ids: [],
      },
    ],
    slices: LOCAL_SLICES.map(slice),
    terminal_checkpoint: 'LOCAL-CASES',
    limitations: ['Test fixture; not a real stack.'],
    source_archives: [],
    previous_definition: {
      revision: '0.2.0',
      snapshot_path: 'provenance/previous-map.source.txt',
      sha256: '',
      archive_sha256: 'e'.repeat(64),
      approval_inherited: false,
    },
    resource_profiles: [
      {
        id: 'isolated-development-workspace',
        description: 'Unique worktree and isolated test state.',
        requires_hardware_virtualization: false,
        fixture_authorization_required: false,
      },
      {
        id: 'controlled-native-test-host',
        description: 'Operator-approved native test environment.',
        requires_hardware_virtualization: false,
        fixture_authorization_required: true,
      },
      {
        id: 'kata-instance-test-host',
        description: 'Disposable Kata test allocation.',
        requires_hardware_virtualization: true,
        fixture_authorization_required: true,
      },
    ],
    acceptance_coverage: [
      {
        id: 'CASE-PARENT',
        source_id: 'local-cases',
        source_record_sha256: '',
        checkpoint: 'LOCAL-CASES',
        owner_work_item: 'local/AQ-01',
        producing_slices: ['local/AQ-01/a'],
        requires_kata_host: false,
        evidence_status_on_import: 'unresolved',
      },
    ],
    planning_targets: [
      { id: 'LOCAL', checkpoint: 'LOCAL-CASES', scope: 'Local proof', is_release: false },
    ],
    aq_baseline_binding: {
      repository: UPSTREAM,
      source_status: 'implemented-source-supplied',
      archive_sha256: '',
      source_tree_sha256: 'd'.repeat(64),
      source_tree_file_count: 1,
      implementation_commit: null,
      historical_pre_contract_commit: 'f'.repeat(40),
      historical_commit_is_current_implementation_pin: false,
      contract: 'BASE-CONTRACT',
      crate_version: '0.2.0',
      conformance_package_revision: 16,
      acceptance_checkpoint: BASELINE_ACCEPTED,
      consumer_conformance_status: 'not-run',
      publication_checkpoint: BASELINE_PUBLISHED,
      publication_status: 'not-verified',
      active_work_item_count: 0,
      source_lock_ids: [],
      retired_work_items: [`${UPSTREAM}/UP-01`],
      retired_adr_checkpoints: [],
      retired_deferred_decisions: [],
    },
    baseline_acceptance_coverage: [],
  };
}

/** One entry of the sealed package: a path under the map root and its bytes. */
export interface MapEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Completes a local map into a v0.3 package the importer accepts: scaffolding the format
 * requires, generated source documents and every digest that binds the map to them.
 */
export function sealLocalMap(input: ConcurrencySource): {
  source: ConcurrencySource;
  entries: MapEntry[];
} {
  const s = structuredClone(input) as Mutable<ConcurrencySource>;
  const baseline = { ...s.aq_baseline_binding } as Mutable<
    ConcurrencySource['aq_baseline_binding']
  >;
  const repositories = [...s.repositories];
  if (!repositories.some((r) => r.id === baseline.repository))
    repositories.push(repository(baseline.repository, 'implemented_upstream'));
  if (repositories.filter((r) => r.role === 'planned_application').length < 2)
    repositories.push(repository(PEER, 'planned_application'));
  const checkpoints = [...s.checkpoints];
  if (!checkpoints.some((c) => c.id === baseline.acceptance_checkpoint))
    checkpoints.push(
      checkpoint(baseline.acceptance_checkpoint, { kind: 'baseline_acceptance', owner: 'stack' }),
    );
  if (!checkpoints.some((c) => c.id === baseline.publication_checkpoint))
    checkpoints.push(
      checkpoint(baseline.publication_checkpoint, {
        kind: 'release',
        owner: baseline.repository,
        requires: [{ kind: 'checkpoint', id: baseline.acceptance_checkpoint, state: 'passed' }],
      }),
    );
  s.checkpoints = checkpoints;
  // The format requires at least one acceptance case. A map whose test declares none gets one
  // on the peer lane, where no local scope owns or produces it.
  if (!s.acceptance_coverage.length) {
    const lane = repositories.find((r) => r.id === PEER);
    if (lane) {
      const parent = `${lane.id}/PE-01`,
        work = `${parent}/work`;
      s.work_items = [
        ...s.work_items,
        {
          ...s.work_items[0]!,
          id: parent,
          repository: lane.id,
          title: 'Peer lane work',
          depends_on: [],
          required_slices: [work],
          acceptance_requires: [{ kind: 'slice', id: work, state: 'verified' }],
          source_profile_case_ids: ['PEER-CASE'],
          profile_evidence_slices: [],
          aq_baseline_case_ids: [],
          source_test_reference: {
            source_id: `${lane.id}-plan`,
            section: 'PE-01',
            start_line: 1,
            end_line: 2,
          },
        },
      ];
      s.slices = [
        ...s.slices,
        {
          ...slice(work),
          work_item: parent,
          merge_lock: lane.merge_lock ?? `${lane.id}-target-branch`,
          source_refs: [{ source_id: `${lane.id}-plan`, section: 'PE-01' }],
          start_requires: [],
          merge_requires: [],
          verify_requires: [],
          decision_refs: [],
          aq_baseline_case_ids: [],
        },
      ];
      s.acceptance_coverage = [
        {
          id: 'PEER-CASE',
          source_id: `${lane.id}-cases`,
          source_record_sha256: '',
          checkpoint: baseline.acceptance_checkpoint,
          owner_work_item: parent,
          producing_slices: [work],
          requires_kata_host: false,
          evidence_status_on_import: 'unresolved',
        },
      ];
    }
  }

  const entries: MapEntry[] = [];
  const files: Mutable<ConcurrencySource['source_files'][number]>[] = [];
  const add = (repo: string, id: string, format: 'markdown' | 'json', text: string) => {
    const bytes = Buffer.from(text, 'utf8');
    const snapshot_path = `source-snapshots/${id}.source.txt`;
    entries.push({ path: snapshot_path, bytes });
    files.push({
      id,
      repository: repo,
      original_path: `${repo}/docs/${id}.${format === 'json' ? 'json' : 'md'}`,
      snapshot_path,
      sha256: sha256Hex(bytes),
      format,
      role: 'source_only_not_an_importable_plan',
    });
  };
  const record = <T>(value: T): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
  const localId = (id: string) => id.slice(id.indexOf('/') + 1);

  // Cases are bound to a case document of their owner's repository.
  const caseFile = (owner: string, baselineCase: boolean) =>
    `${owner.slice(0, owner.indexOf('/'))}-${baselineCase ? 'baseline-cases' : 'cases'}`;
  const cases = s.acceptance_coverage.map((c) => {
    const original = {
      id: c.id,
      owner_pr: localId(c.owner_work_item),
      checkpoint: c.checkpoint,
      requires_kata_host: c.requires_kata_host,
    };
    return {
      original,
      bound: {
        ...c,
        source_id: caseFile(c.owner_work_item, false),
        source_record_sha256: sourceRecordDigest(record(original)),
      },
    };
  });
  const baselineCases = s.baseline_acceptance_coverage.map((c) => {
    const original = {
      id: c.id,
      owner_pr: localId(c.owner_work_item),
      capability_gate: c.capability_gate,
    };
    return {
      original,
      bound: {
        ...c,
        source_id: caseFile(c.owner_work_item, true),
        source_record_sha256: sourceRecordDigest(record(original)),
      },
    };
  });
  s.acceptance_coverage = cases.map((c) => c.bound);
  s.baseline_acceptance_coverage = baselineCases.map((c) => c.bound);

  const workItems = s.work_items.map((p) => ({ ...p, source_item_id: localId(p.id) }));
  const lock = `${baseline.repository}-lock`;
  s.repositories = repositories.map((declared) => {
    const repo = {
      ...declared,
      source_plan: `${declared.id}-plan`,
      source_work_breakdown: `${declared.id}-work-breakdown`,
    };
    const supplements: string[] = [];
    const plan = Array.from({ length: PLAN_LINES }, (_, i) => `${repo.id} plan line ${i + 1}`);
    add(repo.id, repo.source_plan, 'markdown', plan.join('\n'));
    const originals = workItems
      .filter((p) => p.repository === repo.id && repo.role === 'planned_application')
      .map((p) => ({
        id: p.source_item_id,
        title: p.title,
        exit_gate: p.source_exit_gate,
        risk: p.risk,
        primary_areas: p.primary_areas,
        depends_on: p.depends_on.map(localId),
        aq_baseline_acceptance_cases: p.aq_baseline_case_ids,
      }));
    add(repo.id, repo.source_work_breakdown, 'json', JSON.stringify({ pull_requests: originals }));
    for (const [suffix, documents] of [
      ['cases', cases],
      ['baseline-cases', baselineCases],
    ] as const) {
      const owned = documents.filter((c) => c.bound.source_id === `${repo.id}-${suffix}`);
      if (!owned.length) continue;
      add(
        repo.id,
        `${repo.id}-${suffix}`,
        'json',
        JSON.stringify({ cases: owned.map((c) => c.original) }),
      );
      supplements.push(`${repo.id}-${suffix}`);
    }
    if (repo.id === baseline.repository) {
      const identity = {
        archive_sha256: sha256Hex(Buffer.from(`${repo.id} archive`)),
        source_tree_sha256: baseline.source_tree_sha256,
        source_tree_file_count: baseline.source_tree_file_count,
        conformance_package_revision: baseline.conformance_package_revision,
        implementation_commit: baseline.implementation_commit,
      };
      add(repo.id, lock, 'json', JSON.stringify(identity));
      supplements.push(lock);
    }
    for (const p of originals)
      for (const w of workItems)
        if (w.repository === repo.id && w.source_item_id === p.id)
          w.source_record_sha256 = sourceRecordDigest(record(p));
    return {
      ...repo,
      supplement_sources: supplements,
      ...(repo.role === 'planned_application'
        ? { merge_lock: repo.merge_lock ?? `${repo.id}-target-branch` }
        : { target_branch: null, merge_lock: null }),
    };
  });
  s.work_items = workItems;
  s.source_files = files;
  s.source_archives = s.repositories.map((repo) => ({
    repository: repo.id,
    filename: `${repo.id}.zip`,
    sha256: sha256Hex(Buffer.from(`${repo.id} archive`)),
    artifact_revision: repo.artifact_revision,
  }));
  s.resource_locks = s.repositories
    .filter((repo) => repo.merge_lock !== null)
    .map((repo) => ({
      id: repo.merge_lock as string,
      repository: repo.id,
      capacity: 1,
      stage: 'merge',
      scope: 'atomic merge admission into the integration branch',
    }));
  baseline.archive_sha256 = sha256Hex(Buffer.from(`${baseline.repository} archive`));
  baseline.source_lock_ids = [lock];
  s.aq_baseline_binding = baseline;

  const previous = Buffer.from(
    JSON.stringify({
      revision: s.previous_definition.revision,
      work_items: baseline.retired_work_items.map((id) => ({
        id,
        repository: baseline.repository,
      })),
      checkpoints: [],
    }),
  );
  entries.push({ path: s.previous_definition.snapshot_path, bytes: previous });
  s.previous_definition = { ...s.previous_definition, sha256: sha256Hex(previous) };
  return { source: s, entries };
}

/** The sealed map as the ZIP an operator would upload. */
export function localMapArchive(source: ConcurrencySource): Buffer {
  const sealed = sealLocalMap(source);
  return zipFixture([
    {
      path: `${LOCAL_MAP_ROOT}cross-stack-concurrency-map.yaml`,
      bytes: Buffer.from(JSON.stringify(sealed.source)),
    },
    ...sealed.entries.map((e) => ({ path: LOCAL_MAP_ROOT + e.path, bytes: e.bytes })),
  ]);
}

/**
 * The imported map as the scope fixtures store it: the repositories the test declared, their
 * work, sources and archives, under the test's map id. The upstream baseline binding, its
 * checkpoints, the second merge lane and any peer case stay, so the source keeps the v0.3
 * shape (two merge locks, at least one case); none of them names a stored scope.
 */
export function withoutScaffolding(
  imported: ConcurrencySource,
  declared: ConcurrencySource,
): ConcurrencySource {
  const kept = new Set(declared.repositories.map((r) => r.id));
  const work = imported.work_items.filter((p) => kept.has(p.repository));
  return {
    ...imported,
    map_id: declared.map_id,
    repositories: imported.repositories.filter((r) => kept.has(r.id)),
    work_items: work,
    slices: imported.slices.filter((s) => work.some((p) => p.id === s.work_item)),
    source_files: imported.source_files.filter((f) => kept.has(f.repository)),
    source_archives: imported.source_archives.filter((a) => kept.has(a.repository)),
  };
}
