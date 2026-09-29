import type { StorageRepositories } from '@craftingtable/storage';
const calculations = new WeakMap<StorageRepositories, Map<string, unknown>>();
/** Only memoizes inside an explicitly bounded read snapshot; ordinary storage reads stay fresh. */
export function snapshotCalculation<T>(
  tx: StorageRepositories,
  key: string,
  calculate: () => T,
): T {
  const cache = calculations.get(tx);
  if (!cache) return calculate();
  if (!cache.has(key)) cache.set(key, calculate());
  return cache.get(key) as T;
}
/** Synchronous projection only. Never retain this snapshot across awaits or mutations. */
export function mapReadSnapshot(source: StorageRepositories): StorageRepositories {
  if (calculations.has(source)) return source;
  function memo<T extends object>(repo: T, names: readonly (keyof T)[]): T {
    const caches = new Map<PropertyKey, Map<string, unknown>>();
    return new Proxy(repo, {
      get(target, key, receiver) {
        const method = Reflect.get(target, key, receiver);
        if (typeof method !== 'function' || !names.includes(key as keyof T)) return method;
        const values = caches.get(key) ?? new Map<string, unknown>();
        caches.set(key, values);
        return (...args: unknown[]) => {
          const id = JSON.stringify(args);
          if (!values.has(id)) values.set(id, Reflect.apply(method, target, args));
          return values.get(id);
        };
      },
    });
  }
  const snapshot = {
    ...source,
    planning: {
      ...source.planning,
      workItems: memo(source.planning.workItems, ['find']),
      projects: memo(source.planning.projects, ['find']),
      dependencies: memo(source.planning.dependencies, ['listPredecessors']),
    },
    execution: {
      ...source.execution,
      worktrees: memo(source.execution.worktrees, [
        'find',
        'listActive',
        'listForWorkItem',
        'mergedIntoAfter',
      ]),
      cycles: memo(source.execution.cycles, [
        'find',
        'listActive',
        'listForWorkspace',
        'activeForWorktree',
      ]),
      runs: memo(source.execution.runs, ['find', 'listForWorktree']),
      runEvents: memo(source.execution.runEvents, ['latestOfKind']),
      branchSettings: memo(source.execution.branchSettings, ['find', 'policy']),
      sourceRepositories: memo(source.execution.sourceRepositories, ['find']),
    },
    scopeReceipts: memo(source.scopeReceipts, ['list']),
    phaseScheduling: memo(source.phaseScheduling, ['capacity', 'active', 'authorized']),
    imports: memo(source.imports, [
      'definition',
      'bindings',
      'adoptions',
      'archiveInfo',
      'planLinks',
    ]),
    roadmaps: memo(source.roadmaps, ['list', 'find', 'history', 'definition']),
    amendments: memo(source.amendments, [
      'list',
      'pending',
      'retired',
      'superseded',
      'integrations',
    ]),
    runtimeEvidence: memo(source.runtimeEvidence, [
      'generations',
      'submissions',
      'decisions',
      'nativeApprovals',
      'upstreamTransitions',
      'checkDeclarations',
      'checkDeclaration',
      'run',
      'build',
    ]),
  };
  calculations.set(snapshot, new Map());
  return snapshot;
}
