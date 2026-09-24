import {
  type ConcurrencyRequirement,
  type ConcurrencySource,
  concurrencyMilestones,
  type JsonValue,
} from '@craftingtable/domain';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  ARCHIVE_LIMITS,
  type ArchiveEntry,
  ArchiveError,
  decodeUtf8,
  readArchive,
  safeArchivePath,
} from './archive.js';
import { concurrencySourceSchema } from './concurrency-schema.js';
import { sha256Hex } from './digest.js';
import { normalizeJsonDocument, parseYamlDocument } from './parse.js';

export interface ImportDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}
export interface ConcurrencyAnalysis {
  readonly source?: ConcurrencySource;
  readonly digest?: string;
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly graphNodeCount: number;
  readonly graphEdgeCount: number;
}
const validate = new Ajv2020({
  strict: true,
  strictTypes: false,
  allErrors: false,
  validateFormats: false,
}).compile<ConcurrencySource>(concurrencySourceSchema);
/**
 * Checks a stored map source against the reviewed v0.3 schema, the format's ground truth
 * (R-H3). Returns the violations; empty when the source conforms.
 */
export function concurrencySourceIssues(value: unknown): readonly string[] {
  return validate(value)
    ? []
    : (validate.errors ?? []).map(
        (e) =>
          `${e.instancePath || '/'} ${e.message ?? 'is invalid'} (${JSON.stringify(e.params)})`,
      );
}
const obj = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
const array = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
const strings = (value: JsonValue | undefined) =>
  array(value).filter((x): x is string => typeof x === 'string');
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === new Set(a).size &&
  b.length === new Set(b).size &&
  a.length === b.length &&
  a.every((x) => b.includes(x));
export function canonicalSourceRecord(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSourceRecord).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalSourceRecord((value as Record<string, JsonValue>)[k] as JsonValue)}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
export const sourceRecordDigest = (value: JsonValue): string =>
  sha256Hex(Buffer.from(canonicalSourceRecord(value), 'utf8'));
const key = (r: ConcurrencyRequirement) => `${r.kind}:${r.id}:${r.state}`;
const parentKey = (id: string) => `work_item:${id}:accepted`;
const sliceKey = (id: string, state = 'verified') => `slice:${id}:${state}`;
const checkpointKey = (id: string) => `checkpoint:${id}:passed`;

export function analyzeConcurrencyArchive(bytes: Uint8Array): ConcurrencyAnalysis {
  let entries: readonly ArchiveEntry[];
  try {
    entries = readArchive(bytes);
  } catch (error) {
    return failed(error);
  }
  const candidates = entries.filter(
    (e) => e.path.split('/').at(-1) === 'cross-stack-concurrency-map.yaml',
  );
  if (candidates.length !== 1)
    return failed(
      new ArchiveError(
        'map-document-count',
        'ZIP must contain exactly one current cross-stack-concurrency-map.yaml. Historical copies must use an inert extension.',
      ),
    );
  const entry = candidates[0] as ArchiveEntry;
  const root = entry.path.slice(0, entry.path.lastIndexOf('/') + 1);
  let parsed: ReturnType<typeof parseYamlDocument>;
  try {
    parsed = parseYamlDocument(decodeUtf8(entry.bytes), entry.path, true);
  } catch (error) {
    return failed(error);
  }
  if (!parsed.ok) return { diagnostics: parsed.diagnostics, graphNodeCount: 0, graphEdgeCount: 0 };
  const result = analyzeConcurrencyDefinition(parsed.value, entries, root);
  return result.source ? { ...result, digest: sha256Hex(entry.bytes) } : result;
}
/** Shared import/Planning Studio validation seam. No persistence or execution authority. */
export function analyzeConcurrencyDefinition(
  value: unknown,
  entries: readonly ArchiveEntry[],
  root = '',
): ConcurrencyAnalysis {
  try {
    if (
      (root && (!root.endsWith('/') || !safeArchivePath(root.slice(0, -1)))) ||
      entries.length > ARCHIVE_LIMITS.maxEntries ||
      new Set(entries.map((e) => e.path)).size !== entries.length ||
      entries.some(
        (e) =>
          !safeArchivePath(e.path) ||
          e.bytes.byteLength > ARCHIVE_LIMITS.maxEntryBytes ||
          sha256Hex(e.bytes) !== e.sha256,
      ) ||
      entries.reduce((n, e) => n + e.bytes.byteLength, 0) > ARCHIVE_LIMITS.maxExpandedBytes
    )
      throw new ArchiveError(
        'invalid-snapshots',
        'Invalid, duplicate, oversized or incorrectly hashed source snapshots.',
      );
    const parsed = normalizeJsonDocument(value, 'normalized-map.json');
    if (!parsed.ok)
      return { diagnostics: parsed.diagnostics, graphNodeCount: 0, graphEdgeCount: 0 };
    value = parsed.value;
    if (Buffer.byteLength(JSON.stringify(value)) > ARCHIVE_LIMITS.maxEntryBytes)
      throw new ArchiveError('map-size', 'Normalized map exceeds document limits.');
  } catch (error) {
    return failed(error);
  }
  if (!validate(value))
    return {
      diagnostics: (validate.errors ?? []).slice(0, 20).map((e) => ({
        severity: 'error',
        code: 'unsupported-map-schema',
        message:
          `${e.instancePath || '/'} ${e.message ?? 'is invalid'} (${JSON.stringify(e.params)})`.slice(
            0,
            1000,
          ),
        path: e.instancePath,
      })),
      graphNodeCount: 0,
      graphEdgeCount: 0,
    };
  const source = value;
  const diagnostics: ImportDiagnostic[] = [];
  const require = (ok: boolean, code: string, message: string) => {
    if (!ok && diagnostics.length < 100)
      diagnostics.push({ severity: 'error', code, message: message.slice(0, 1000) });
  };
  const index = <T extends { readonly id: string }>(items: readonly T[], label: string) => {
    const result = new Map<string, T>();
    for (const item of items) {
      require(!result.has(item.id), 'duplicate-map-id', `${label}: duplicate ${item.id}`);
      require(item.id.length <= 200 &&
        !Array.from(item.id).some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        ), 'invalid-map-id', `${label}: invalid ID`);
      result.set(item.id, item);
    }
    return result;
  };
  const repos = index(source.repositories, 'repositories');
  require(repos.size <= 32, 'repository-limit', 'A map may bind at most 32 repositories.');
  const files = index(source.source_files, 'source_files');
  const parents = index(source.work_items, 'work_items');
  const slices = index(source.slices, 'slices');
  const checkpoints = index(source.checkpoints, 'checkpoints');
  const decisions = index(source.decisions, 'decisions');
  const evidence = index(source.evidence_profiles, 'evidence_profiles');
  const resources = index(source.resource_profiles, 'resource_profiles');
  const locks = index(source.resource_locks, 'resource_locks');
  const targets = index(source.planning_targets, 'planning_targets');
  const cases = index(source.acceptance_coverage, 'acceptance_coverage');
  const baselineCases = index(source.baseline_acceptance_coverage, 'baseline_acceptance_coverage');
  index(source.deferred_decisions, 'deferred_decisions');
  require(sameSet(
    source.source_archives.map((a) => a.repository),
    [...repos.keys()],
  ), 'source-archive-binding', 'Every repository requires exactly one source archive binding.');
  const content = new Map<string, JsonValue>();
  const lines = new Map<string, number>();
  for (const file of files.values()) {
    require(repos.has(
      file.repository,
    ), 'unknown-reference', `${file.id}: unknown repository ${file.repository}`);
    require(safeArchivePath(file.original_path) &&
      safeArchivePath(file.snapshot_path), 'unsafe-source-path', `${file.id}: unsafe source path`);
    const snapshot = entries.find((e) => e.path === root + file.snapshot_path);
    require(snapshot?.sha256 ===
      file.sha256, 'source-hash-mismatch', `${file.id}: missing or changed source snapshot`);
    if (!snapshot) continue;
    try {
      const text = decodeUtf8(snapshot.bytes);
      lines.set(file.id, text.split('\n').length);
      if (file.format !== 'markdown') {
        const result = parseYamlDocument(text, file.id, true);
        require(result.ok, 'invalid-source', `${file.id}: unsafe or invalid source document`);
        if (result.ok) content.set(file.id, result.value);
      }
    } catch {
      require(false, 'invalid-source', `${file.id}: invalid UTF-8`);
    }
  }
  const previous = entries.find((e) => e.path === root + source.previous_definition.snapshot_path);
  require(safeArchivePath(source.previous_definition.snapshot_path) &&
    previous?.sha256 ===
      source.previous_definition
        .sha256, 'source-hash-mismatch', 'Previous definition snapshot is missing or changed.');
  for (const item of [...source.work_items, ...source.slices, ...source.checkpoints]) {
    const lists =
      'acceptance_requires' in item
        ? [item.acceptance_requires]
        : 'start_requires' in item
          ? [item.start_requires, item.merge_requires, item.verify_requires]
          : [item.requires];
    for (const list of lists)
      require(new Set(list.map(key)).size ===
        list.length, 'duplicate-requirement', `${item.id}: duplicate phase requirement`);
  }
  const graph = new Map<string, Set<string>>();
  for (const parent of parents.values())
    graph.set(parentKey(parent.id), new Set(parent.acceptance_requires.map(key)));
  for (const slice of slices.values()) {
    graph.set(sliceKey(slice.id, 'started'), new Set(slice.start_requires.map(key)));
    graph.set(
      sliceKey(slice.id, 'merged'),
      new Set([sliceKey(slice.id, 'started'), ...slice.merge_requires.map(key)]),
    );
    graph.set(
      sliceKey(slice.id),
      new Set([sliceKey(slice.id, 'merged'), ...slice.verify_requires.map(key)]),
    );
  }
  for (const cp of checkpoints.values())
    graph.set(checkpointKey(cp.id), new Set(cp.requires.map(key)));
  const refs = (
    owner: string,
    sourceRefs: readonly { source_id: string; start_line?: number; end_line?: number }[],
    decisionRefs: readonly string[] = [],
  ) => {
    for (const r of sourceRefs)
      require(files.has(r.source_id) &&
        (r.end_line === undefined ||
          (r.end_line <= (lines.get(r.source_id) ?? 0) &&
            (r.start_line ?? 1) <=
              r.end_line)), 'unknown-reference', `${owner}: invalid source reference ${r.source_id}`);
    for (const id of decisionRefs)
      require(decisions.has(id), 'unknown-reference', `${owner}: unknown decision ${id}`);
  };
  for (const repo of repos.values()) {
    const declared = [repo.source_plan, repo.source_work_breakdown, ...repo.supplement_sources];
    require(sameSet(
      declared,
      source.source_files.filter((f) => f.repository === repo.id).map((f) => f.id),
    ), 'source-binding', `${repo.id}: declared sources do not match the repository's complete source set`);
    for (const id of declared)
      require(files.get(id)?.repository ===
        repo.id, 'source-binding', `${repo.id}: invalid source ${id}`);
    if (repo.role === 'implemented_upstream') {
      require(repo.target_branch === null &&
        repo.merge_lock === null &&
        !source.work_items.some(
          (p) => p.repository === repo.id,
        ), 'upstream-not-runnable', `${repo.id}: implemented upstream cannot own runnable work or a merge lane`);
      continue;
    }
    require(repo.target_branch !== null &&
      locks.get(repo.merge_lock ?? '')?.repository ===
        repo.id, 'merge-lock-binding', `${repo.id}: missing or mismatched merge lane`);
    const originals = array(obj(content.get(repo.source_work_breakdown)).pull_requests).map(obj);
    const expected = source.work_items.filter((p) => p.repository === repo.id);
    require(sameSet(
      originals.map((p) => String(p.id)),
      expected.map((p) => p.source_item_id),
    ), 'parent-coverage', `${repo.id}: map must retain every original work item exactly once`);
    for (const parent of expected) {
      const original = originals.find((p) => p.id === parent.source_item_id);
      if (!original) continue;
      require(sourceRecordDigest(original) ===
        parent.source_record_sha256, 'source-record-mismatch', `${parent.id}: complete source record changed`);
      require(parent.id === `${repo.id}/${parent.source_item_id}` &&
        parent.title === original.title &&
        parent.source_exit_gate === original.exit_gate &&
        parent.risk === original.risk &&
        sameSet(
          parent.primary_areas,
          strings(original.primary_areas),
        ), 'source-record-mismatch', `${parent.id}: source work-item scope changed`);
      require(sameSet(
        parent.depends_on,
        strings(original.depends_on).map((id) => `${repo.id}/${id}`),
      ), 'parent-dependencies', `${parent.id}: original dependency set changed`);
      require(sameSet(
        parent.aq_baseline_case_ids,
        strings(original.aq_baseline_acceptance_cases),
      ), 'case-coverage', `${parent.id}: original baseline case assignments changed`);
    }
  }
  for (const lock of locks.values())
    require(repos.get(lock.repository)?.merge_lock ===
      lock.id, 'merge-lock-binding', `${lock.id}: lock is not owned by its repository`);
  for (const parent of parents.values()) {
    require(repos.get(parent.repository)?.role ===
      'planned_application', 'unknown-reference', `${parent.id}: invalid planned repository`);
    require(evidence.has(
      parent.acceptance_evidence_profile,
    ), 'unknown-reference', `${parent.id}: unknown acceptance evidence profile`);
    require(sameSet(
      parent.required_slices,
      source.slices.filter((s) => s.work_item === parent.id).map((s) => s.id),
    ), 'slice-coverage', `${parent.id}: required slices do not match owned slices`);
    const requirements = graph.get(parentKey(parent.id)) as Set<string>;
    for (const id of parent.depends_on)
      require(parents.has(id) &&
        requirements.has(
          parentKey(id),
        ), 'parent-dependencies', `${parent.id}: parent acceptance must retain ${id}`);
    for (const id of [...parent.required_slices, ...parent.profile_evidence_slices])
      require(slices.has(id) &&
        requirements.has(
          sliceKey(id),
        ), 'slice-coverage', `${parent.id}: acceptance must require verified ${id}`);
    require(sameSet(
      parent.source_profile_case_ids,
      source.acceptance_coverage.filter((c) => c.owner_work_item === parent.id).map((c) => c.id),
    ), 'case-coverage', `${parent.id}: source case ownership is incomplete`);
    require(sameSet(
      parent.aq_baseline_case_ids,
      source.baseline_acceptance_coverage
        .filter((c) => c.owner_work_item === parent.id)
        .map((c) => c.id),
    ), 'case-coverage', `${parent.id}: baseline case ownership is incomplete`);
    refs(parent.id, [parent.source_test_reference]);
  }
  for (const slice of slices.values()) {
    const parent = parents.get(slice.work_item);
    require(!!parent &&
      slice.id.startsWith(
        `${slice.work_item}/`,
      ), 'unknown-reference', `${slice.id}: invalid parent`);
    require(evidence.has(slice.evidence_profile) &&
      locks.get(slice.merge_lock)?.repository ===
        parent?.repository, 'unknown-reference', `${slice.id}: invalid evidence profile or merge lane`);
    for (const ids of Object.values(slice.resources_by_phase))
      for (const id of ids)
        require(resources.has(id), 'unknown-reference', `${slice.id}: unknown resource ${id}`);
    require(sameSet(
      slice.aq_baseline_case_ids,
      source.baseline_acceptance_coverage
        .filter((c) => c.producing_slice === slice.id)
        .map((c) => c.id),
    ), 'case-coverage', `${slice.id}: baseline producer coverage changed`);
    refs(slice.id, slice.source_refs, slice.decision_refs);
  }
  for (const cp of checkpoints.values()) {
    require(cp.owner === 'stack' ||
      repos.has(cp.owner), 'unknown-reference', `${cp.id}: unknown owner ${cp.owner}`);
    require(evidence.has(
      cp.evidence_profile,
    ), 'unknown-reference', `${cp.id}: unknown evidence profile`);
    for (const id of cp.evidence_owners ?? [])
      require(parents.has(id), 'unknown-reference', `${cp.id}: unknown evidence owner ${id}`);
    refs(cp.id, cp.source_refs, cp.decision_refs);
  }
  for (const c of [...cases.values(), ...baselineCases.values()]) {
    const baseline = 'producing_slice' in c;
    const producers = baseline ? [c.producing_slice] : c.producing_slices;
    const checkpoint = baseline ? c.capability_gate : c.checkpoint;
    require(files.has(c.source_id) &&
      parents.has(c.owner_work_item) &&
      checkpoints.has(
        checkpoint,
      ), 'unknown-reference', `${c.id}: invalid case source, owner or checkpoint`);
    for (const id of producers) {
      require(slices.has(id), 'unknown-reference', `${c.id}: unknown producer ${id}`);
      require(graph.get(parentKey(c.owner_work_item))?.has(sliceKey(id)) ===
        true, 'case-coverage', `${c.id}: owner must await verified producer ${id}`);
    }
    const original = array(obj(content.get(c.source_id)).cases)
      .map(obj)
      .find((o) => o.id === c.id);
    require(!!original &&
      sourceRecordDigest(original) ===
        c.source_record_sha256, 'source-record-mismatch', `${c.id}: missing or changed source case`);
    if (original) {
      const repo = files.get(c.source_id)?.repository;
      require(c.owner_work_item === `${repo}/${original.owner_pr}` &&
        checkpoint ===
          original[
            baseline ? 'capability_gate' : 'checkpoint'
          ], 'case-coverage', `${c.id}: source owner or gate changed`);
      if (!baseline)
        require(c.requires_kata_host ===
          original.requires_kata_host, 'case-coverage', `${c.id}: hardware requirement changed`);
    }
  }
  for (const [id, value] of content) {
    const valueObj = obj(value);
    const boundCases = [...cases.values(), ...baselineCases.values()].filter(
      (c) => c.source_id === id,
    );
    if (boundCases.length || array(valueObj.cases).some((c) => typeof obj(c).owner_pr === 'string'))
      require(sameSet(
        array(valueObj.cases).map((c) => String(obj(c).id)),
        boundCases.map((c) => c.id),
      ), 'case-coverage', `${id}: source cases were omitted or duplicated`);
    if (valueObj.kind === 'worker_provider_planning_reference') {
      const owner = source.repositories.find((r) => r.repository === valueObj.owner_repository);
      require(!!owner &&
        owner.planning_profile === valueObj.owner_plan_revision &&
        owner.artifact_revision ===
          valueObj.owner_package_artifact, 'provider-binding', `${id}: provider ownership/version mismatch`);
      for (const [filename, hash] of Object.entries(obj(valueObj.files))) {
        const matches = source.source_files.filter(
          (f) => f.repository === owner?.id && f.original_path.split('/').at(-1) === filename,
        );
        require(matches.length === 1 &&
          matches[0]?.sha256 ===
            hash, 'provider-binding', `${id}: mismatched provider document ${filename}`);
      }
    }
    // Preserve profile-owned checkpoint criteria and prerequisites without interpreting prose.
    for (const pc of array(valueObj.checkpoints)
      .map(obj)
      .filter((c) => typeof c.criterion === 'string')) {
      const cp = checkpoints.get(String(pc.id));
      require(!!cp &&
        cp.pass_criteria.includes(
          String(pc.criterion),
        ), 'checkpoint-preservation', `${pc.id}: source profile criterion missing`);
      if (pc.evidence_owners !== undefined)
        require(sameSet(
          strings(pc.evidence_owners).map((owner) => `${files.get(id)?.repository}/${owner}`),
          cp?.evidence_owners ?? [],
        ), 'checkpoint-preservation', `${pc.id}: source evidence owners changed`);
      for (const required of [
        ...strings(pc.requires_checkpoints),
        ...strings(pc.required_aq_gates_for_real_integration),
      ])
        require(cp?.requires.some((r) => r.kind === 'checkpoint' && r.id === required) ===
          true, 'checkpoint-preservation', `${pc.id}: source profile prerequisite ${required} missing`);
    }
  }
  const baseline = source.aq_baseline_binding;
  require(repos.get(baseline.repository)?.role === 'implemented_upstream' &&
    source.source_archives.find((a) => a.repository === baseline.repository)?.sha256 ===
      baseline.archive_sha256, 'baseline-binding', 'Implemented baseline repository/archive mismatch.');
  for (const id of [baseline.acceptance_checkpoint, baseline.publication_checkpoint])
    require(checkpoints.has(id), 'unknown-reference', `Unknown baseline checkpoint ${id}`);
  for (const id of baseline.source_lock_ids) {
    const lock = obj(content.get(id));
    for (const field of [
      'archive_sha256',
      'source_tree_sha256',
      'source_tree_file_count',
      'conformance_package_revision',
      'implementation_commit',
    ] as const)
      require(lock[field] ===
        baseline[field], 'baseline-binding', `${id}: baseline ${field} mismatch`);
  }
  for (const id of baseline.retired_work_items)
    require(!parents.has(id), 'upstream-not-runnable', `${id}: retired upstream work is runnable`);
  if (previous) {
    try {
      const prior = parseYamlDocument(
        decodeUtf8(previous.bytes),
        source.previous_definition.snapshot_path,
        true,
      );
      require(prior.ok, 'invalid-source', 'Previous definition is invalid.');
      if (prior.ok) {
        const priorMap = obj(prior.value);
        require(priorMap.revision ===
          source.previous_definition
            .revision, 'source-binding', 'Previous revision identity changed.');
        require(sameSet(
          array(priorMap.work_items)
            .map(obj)
            .filter((p) => p.repository === baseline.repository)
            .map((p) => String(p.id)),
          baseline.retired_work_items,
        ), 'baseline-binding', 'Retired upstream work must preserve its complete history.');
        for (const old of array(priorMap.checkpoints)
          .map(obj)
          .filter(
            (c) =>
              ['contract', 'release'].includes(String(c.kind)) &&
              c.id !== baseline.publication_checkpoint,
          )) {
          const current = checkpoints.get(String(old.id));
          require(!!current &&
            strings(old.pass_criteria).every((criterion) =>
              current.pass_criteria.includes(criterion),
            ), 'checkpoint-preservation', `${old.id}: previous contract/release criteria were dropped`);
          for (const r of array(old.requires).map(obj)) {
            const replacement =
              r.kind === 'work_item' && baseline.retired_work_items.includes(String(r.id))
                ? checkpointKey(baseline.acceptance_checkpoint)
                : `${r.kind}:${r.id}:${r.state}`;
            require(current?.requires.some((candidate) => key(candidate) === replacement) ===
              true, 'checkpoint-preservation', `${old.id}: previous requirement ${r.id} was dropped`);
          }
        }
      }
    } catch {
      require(false, 'invalid-source', 'Previous definition cannot be decoded safely.');
    }
  }
  for (const target of targets.values())
    require(checkpoints.has(
      target.checkpoint,
    ), 'unknown-reference', `${target.id}: unknown target checkpoint`);
  require(targets.has(source.scheduling_policy.suggested_focus_target) &&
    checkpoints.has(
      source.terminal_checkpoint,
    ), 'unknown-reference', 'Unknown suggested target or terminal checkpoint.');
  // Validate the expanded phase graph, including implicit started -> merged -> verified links.
  for (const [id, predecessors] of graph)
    for (const predecessor of predecessors)
      require(graph.has(
        predecessor,
      ), 'unknown-reference', `${id}: unknown prerequisite ${predecessor}`);
  // Check acyclicity over the same milestone model that targetClosure, amendments and the
  // supervisor use, which adds implicit edges (parent dependencies before a non-early slice
  // starts; every evidence producer before parent acceptance). Implicit edges to unknown
  // milestones are reported by the reference checks above, so only resolvable ones are added.
  // The reported node/edge counts stay those of the explicit graph: import summaries and
  // plan-acceptance facts already persist them.
  const milestones = new Map([...graph].map(([id, predecessors]) => [id, new Set(predecessors)]));
  if (source.slices.every((slice) => parents.has(slice.work_item)))
    for (const node of concurrencyMilestones(source))
      for (const predecessor of node.requires)
        if (graph.has(predecessor)) milestones.get(node.key)?.add(predecessor);
  const remaining = new Map([...milestones].map(([id, predecessors]) => [id, predecessors.size]));
  const dependents = new Map<string, string[]>();
  for (const [id, predecessors] of milestones)
    for (const p of predecessors) dependents.set(p, [...(dependents.get(p) ?? []), id]);
  const queue = [...remaining].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++)
    for (const id of dependents.get(queue[i] as string) ?? []) {
      const count = (remaining.get(id) as number) - 1;
      remaining.set(id, count);
      if (count === 0) queue.push(id);
    }
  require(queue.length ===
    milestones.size, 'milestone-cycle', `Expanded milestone graph contains a cycle or unresolved dependency: ${[
    ...remaining,
  ]
    .filter(([, n]) => n > 0)
    .slice(0, 5)
    .map(([id]) => id)
    .join(', ')}`);
  return {
    ...(diagnostics.length
      ? {}
      : { source, digest: sourceRecordDigest(source as unknown as JsonValue) }),
    diagnostics,
    graphNodeCount: graph.size,
    graphEdgeCount: [...graph.values()].reduce((n, edges) => n + edges.size, 0),
  };
}
function failed(error: unknown): ConcurrencyAnalysis {
  return {
    diagnostics: [
      {
        severity: 'error',
        code: error instanceof ArchiveError ? error.code : 'invalid-archive',
        message: error instanceof Error ? error.message : 'Invalid archive.',
      },
    ],
    graphNodeCount: 0,
    graphEdgeCount: 0,
  };
}
