import type { StorageRepositories } from '@craftingtable/storage';
/** Synchronous projection only. Never retain this snapshot across awaits or mutations. */
export function mapReadSnapshot(source: StorageRepositories): StorageRepositories {
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
  return {
    ...source,
    imports: memo(source.imports, ['definition', 'bindings', 'adoptions']),
    roadmaps: memo(source.roadmaps, ['list', 'find', 'history']),
    amendments: memo(source.amendments, [
      'list',
      'pending',
      'retired',
      'superseded',
      'integrations',
    ]),
    runtimeEvidence: memo(source.runtimeEvidence, ['generations', 'submissions', 'decisions']),
  };
}
