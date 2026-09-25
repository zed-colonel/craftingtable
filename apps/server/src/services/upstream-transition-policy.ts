import {
  type ConcurrencyDefinition,
  consumerUpstreams,
  effectiveUpstreamTransitions,
  type ExecutionScope,
  sameExecutionScope,
  scopedBuildScope,
  type UpstreamTransition,
  upstreamTransitionIssues,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { UpstreamTransitionUndeclaredError } from './errors.js';
import { snapshotCalculation } from './map-read-snapshot.js';

/** The declarations that apply to a definition: its map's own, then its operator records. */
export function upstreamTransitions(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
) {
  return effectiveUpstreamTransitions(d.source, tx.runtimeEvidence.upstreamTransitions(ws, d.id));
}

/** Every consumer→upstream link, its declaration, and the slices that could declare it. */
export function upstreamTransitionView(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
) {
  const records = tx.runtimeEvidence.upstreamTransitions(ws, d.id);
  return snapshotCalculation(
    tx,
    `upstream-transitions:${ws}:${d.id}:${records.map((r) => r.id).join(',')}`,
    () => {
      const effective = effectiveUpstreamTransitions(d.source, records);
      const declaredOnly = effective.map(({ consumer, upstream, slice }) => ({
        consumer,
        upstream,
        slice,
      }));
      const links = d.source.repositories
        .filter((r) => r.role === 'planned_application')
        .flatMap((r) =>
          consumerUpstreams(d.source, r.id).map((upstream) => ({ consumer: r.id, upstream })),
        );
      return {
        records: [...records],
        links: links.map((link) => {
          const declared = effective.find(
            (t) => t.consumer === link.consumer && t.upstream === link.upstream,
          );
          if (declared)
            return {
              ...link,
              slice: declared.slice,
              declaredBy: declared.recordId ? ('record' as const) : ('map' as const),
              ...(declared.recordId ? { recordId: declared.recordId } : {}),
              candidates: [],
            };
          // A candidate may still need a coupled link declared with it in the same record.
          const candidates = d.source.slices
            .filter(
              (s) =>
                d.source.work_items.find((w) => w.id === s.work_item)?.repository ===
                  link.consumer &&
                !scopedBuildScope(d.source, { kind: 'slice', sourceId: s.id }) &&
                upstreamTransitionIssues(d.source, [
                  ...declaredOnly,
                  { ...link, slice: s.id },
                ]).every((i) => i.code === 'upstream-transition-coupling'),
            )
            .map((s) => s.id);
          return { ...link, candidates };
        }),
      };
    },
  );
}

/**
 * Every recorded merge of a transition slice's scope under this binding: direct merges, and
 * integrated code reused across an amendment. A remediation can merge a scope more than once;
 * a tree containing any of them has moved.
 */
export function transitionMerges(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  scope: Pick<ExecutionScope, 'definitionId' | 'bindingRevision'>,
  transition: UpstreamTransition,
): readonly string[] {
  const parent = d.source.slices.find((s) => s.id === transition.slice)?.work_item;
  const bound = tx.imports
    .bindings(ws, scope.definitionId)
    .find((b) => b.revision === scope.bindingRevision)
    ?.bindings.flatMap((b) => b.workItems)
    .find((w) => w.sourceId === parent);
  if (!bound) return [];
  const target: ExecutionScope = {
    definitionId: scope.definitionId,
    bindingRevision: scope.bindingRevision,
    kind: 'slice',
    sourceId: transition.slice,
  };
  const direct = tx.execution.worktrees
    .listForWorkItem(ws, bound.workItemId)
    .filter((t) => sameExecutionScope(t.executionScope, target))
    .map((t) => t.mergeSha);
  const reused = tx.amendments
    .integrations(ws, bound.workItemId, target)
    .map((r) => tx.execution.worktrees.find(ws, r.sourceWorktreeId)?.mergeSha);
  return [...new Set([...direct, ...reused].filter((sha): sha is string => !!sha))];
}

export interface UpstreamSourceChoice {
  readonly alias: string;
  /** `none`: a scoped link with no historical source stays dependency-free (ADR-053). */
  readonly source: 'current' | 'historical' | 'none';
  readonly transition?: { readonly slice: string; readonly recordId?: string };
}

/**
 * Where each of a consumer's upstream links is supplied from (ADR-069). Work that needs the
 * current pins takes them on every link, and stops on a link nobody declared. A scoped tree takes
 * the current pin on a link whose transition merge is in its history (`moved`), and otherwise
 * the consumer's historical source when one is prepared.
 */
export function chooseUpstreamSources(input: {
  readonly consumer: string;
  readonly upstreams: readonly string[];
  readonly scoped: boolean;
  readonly transitions: readonly (UpstreamTransition & { readonly recordId?: string })[];
  readonly moved: ReadonlySet<string>;
  readonly historical: readonly string[];
}): UpstreamSourceChoice[] {
  return input.upstreams.map((alias) => {
    const transition = input.transitions.find(
      (t) => t.consumer === input.consumer && t.upstream === alias,
    );
    if (!input.scoped && !transition)
      throw new UpstreamTransitionUndeclaredError(
        `Declare when ${input.consumer} moves to the current ${alias} pin before running work that needs it. Approve an upstream transition in the dependency environment settings, or declare it in the next map revision.`,
      );
    const source =
      !input.scoped || input.moved.has(alias)
        ? 'current'
        : input.historical.includes(alias)
          ? 'historical'
          : 'none';
    return {
      alias,
      source,
      ...(transition
        ? {
            transition: {
              slice: transition.slice,
              ...(transition.recordId ? { recordId: transition.recordId } : {}),
            },
          }
        : {}),
    };
  });
}
