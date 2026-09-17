import type { CrossProjectView } from '@craftingtable/contracts';
export type MapNode = CrossProjectView['nodes'][number];
export const phaseLabel = (node: MapNode) =>
  node.kind === 'work_item'
    ? 'Needed to accept parent'
    : node.kind === 'checkpoint'
      ? 'Needed to pass checkpoint'
      : node.state === 'started'
        ? 'Needed to start'
        : node.state === 'merged'
          ? 'Needed to merge'
          : 'Needed to verify';

/** Follow same-project prerequisites to the first provider in another project. */
export function crossProjectRequirements(nodes: readonly MapNode[], roots: readonly MapNode[]) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const result = new Map<string, MapNode>();
  for (const root of roots) {
    const visited = new Set<string>();
    const visit = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const node = byKey.get(key);
      if (!node) return;
      if (node.repository !== root.repository) result.set(key, node);
      else for (const dep of node.requirements) visit(dep);
    };
    for (const key of root.requirements) visit(key);
  }
  return [...result.values()];
}
export function PhaseRequirements({
  nodes,
  roots,
  onTrace,
}: {
  nodes: readonly MapNode[];
  roots: readonly MapNode[];
  onTrace: (key: string) => void;
}) {
  const external = crossProjectRequirements(nodes, roots);
  if (!external.length)
    return <p>No cross-project prerequisites in this item’s dependency chain.</p>;
  const providers = [...new Set(external.map((n) => n.repository.toUpperCase()))].join(', ');
  const phases = [...new Set(roots.map(phaseLabel))];
  return (
    <details className="cross-project-requirements">
      <summary>
        Cross-project requirements · {providers} · {external.length} milestones
      </summary>
      {phases.map((phase) => {
        const required = crossProjectRequirements(
          nodes,
          roots.filter((n) => phaseLabel(n) === phase),
        );
        if (!required.length) return null;
        return (
          <div key={phase}>
            <h5>{phase}</h5>
            <ul>
              {required.map((n) => (
                <li key={n.key}>
                  <button type="button" className="dependency-link" onClick={() => onTrace(n.key)}>
                    {n.repository.toUpperCase()} · {n.sourceId} · {n.title}
                  </button>{' '}
                  —{' '}
                  {n.satisfied
                    ? 'requirement satisfied'
                    : `waiting for ${n.state === 'passed' ? 'checkpoint approval' : n.state}`}
                  {n.kind === 'checkpoint' && n.requirements.length > 0 && (
                    <ul>
                      {n.requirements.map((k) => {
                        const provider = nodes.find((p) => p.key === k);
                        return provider ? (
                          <li key={k}>
                            <button
                              type="button"
                              className="dependency-link"
                              onClick={() => onTrace(k)}
                            >
                              {provider.sourceId} · required: {provider.state}
                            </button>
                            {provider.satisfied ? ' · satisfied' : ' · waiting'}
                          </li>
                        ) : null;
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p>
        Later phases inherit earlier requirements. Checkpoints require their own evidence as well as
        their prerequisites.
      </p>
    </details>
  );
}

/** A bounded, navigable dependency tree; selecting a frontier makes it the new root. */
export function DependencyGraph({
  nodes,
  selected,
  onTrace,
  onLocate,
}: {
  nodes: readonly MapNode[];
  selected: MapNode;
  onTrace: (key: string) => void;
  onLocate: (key: string) => void;
}) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  let remaining = 60;
  const expanded = new Set<string>();
  const branch = (node: MapNode, path: Set<string>, depth: number): React.ReactNode => {
    if (path.has(node.key)) return null;
    const expand = depth < 3 && remaining-- > 0 && !expanded.has(node.key);
    expanded.add(node.key);
    const next = new Set([...path, node.key]);
    return (
      <li key={node.key}>
        <button type="button" className="dependency-link" onClick={() => onTrace(node.key)}>
          {node.repository.toUpperCase()} · {node.sourceId} · {node.state}
        </button>{' '}
        — {node.satisfied ? 'requirement satisfied' : 'waiting'}
        <div>
          {node.title}{' '}
          <button type="button" className="secondary-button" onClick={() => onLocate(node.key)}>
            Show in project
          </button>
        </div>
        {node.requirements.length > 0 &&
          (expand ? (
            <ul>
              {node.requirements.map((key) => {
                const child = byKey.get(key);
                return child ? branch(child, next, depth + 1) : <li key={key}>{key}</li>;
              })}
            </ul>
          ) : (
            <button type="button" className="secondary-button" onClick={() => onTrace(node.key)}>
              Trace {node.requirements.length} prerequisites
            </button>
          ))}
      </li>
    );
  };
  return (
    <section className="dependency-graph" aria-label="Dependency graph">
      <p>
        Each indented row is a prerequisite of the row above it. Select any milestone to focus its
        requirements.
      </p>
      <ul>{branch(selected, new Set(), 0)}</ul>
      {remaining <= 0 && (
        <p>
          Showing a bounded dependency view. Focus a milestone to explore its remaining
          prerequisites.
        </p>
      )}
    </section>
  );
}
