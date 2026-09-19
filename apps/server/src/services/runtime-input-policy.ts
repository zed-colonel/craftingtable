import { canonicalDefinition, type RuntimeGeneration } from '@craftingtable/domain';

const ordered = <T extends { alias?: string; name?: string; id?: string }>(values: readonly T[]) =>
  [...values].sort((a, b) =>
    (a.alias ?? a.name ?? a.id ?? '').localeCompare(b.alias ?? b.name ?? b.id ?? ''),
  );
const equal = (a: unknown, b: unknown) => canonicalDefinition(a) === canonicalDefinition(b);

export function environmentInputs(runtime: RuntimeGeneration, environmentId?: string) {
  return ordered(
    runtime.environments
      .filter((e) => !environmentId || e.id === environmentId)
      .map(({ discovery: _discovery, ...identity }) => identity),
  );
}

/** Compare the immutable inputs, never relabel an older run or manufacture a new receipt. */
export function runtimeInputChanges(
  before: RuntimeGeneration | undefined,
  after: RuntimeGeneration | undefined,
  options: { consumers?: readonly string[]; pins?: readonly string[]; environmentId?: string } = {},
): string[] {
  if (
    !before ||
    !after ||
    before.workspaceId !== after.workspaceId ||
    before.definitionId !== after.definitionId ||
    before.bindingRevision !== after.bindingRevision
  )
    return ['The recorded dependency generation or exact map binding is unavailable.'];
  const issues: string[] = [];
  if (
    !equal(
      environmentInputs(before, options.environmentId),
      environmentInputs(after, options.environmentId),
    ) ||
    (options.environmentId && !after.environments.some((e) => e.id === options.environmentId))
  )
    issues.push('Environment, fixture, toolchain or authorization inputs changed.');
  const pins = new Set(options.pins);
  const consumers = options.consumers ?? [
    ...new Set([...before.consumers, ...after.consumers].map((c) => c.alias)),
  ];
  for (const alias of consumers) {
    const a = before.consumers.find((c) => c.alias === alias);
    const b = after.consumers.find((c) => c.alias === alias);
    if (!a || !b || !equal([...a.upstreams].sort(), [...b.upstreams].sort()))
      issues.push(`Supplied dependencies for ${alias} changed or are missing.`);
    for (const upstream of [...(a?.upstreams ?? []), ...(b?.upstreams ?? [])]) pins.add(upstream);
  }
  if (options.consumers === undefined)
    for (const p of [...before.pins, ...after.pins]) pins.add(p.alias);
  for (const alias of pins) {
    const identity = (r: RuntimeGeneration) => {
      const p = r.pins.find((p) => p.alias === alias);
      if (!p) return;
      const { ref: _ref, packages, ...source } = p;
      return { ...source, packages: ordered(packages) };
    };
    const a = identity(before),
      b = identity(after);
    if (!a || !b || !equal(a, b))
      issues.push(
        `The ${alias} dependency commit, crate mappings or conformance identity changed.`,
      );
  }
  return issues;
}

export function sameRuntimeEnvironments(
  before: RuntimeGeneration | undefined,
  after: RuntimeGeneration | undefined,
): boolean {
  return runtimeInputChanges(before, after, { consumers: [] }).length === 0;
}

export function relevantPinAliases(
  runtime: RuntimeGeneration,
  options: { consumers?: readonly string[]; pins?: readonly string[] },
): string[] {
  return options.consumers === undefined
    ? runtime.pins.map((p) => p.alias)
    : [
        ...new Set([
          ...(options.pins ?? []),
          ...options.consumers.flatMap(
            (alias) => runtime.consumers.find((c) => c.alias === alias)?.upstreams ?? [],
          ),
        ]),
      ];
}
