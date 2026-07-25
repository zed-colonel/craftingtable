import type { WorkspaceSnapshotResponse } from '@craftingtable/contracts';
import type { CSSProperties } from 'react';

export function StatusRegions({
  summary,
}: {
  summary: WorkspaceSnapshotResponse['statusSummary'];
}) {
  // Labels are deliberately unambiguous: CT-03 owns planning readiness only,
  // never executable or merge readiness (CT-03 §5.11).
  const regions = [
    {
      id: 'needs-attention',
      label: 'Needs attention',
      count: summary.needsAttention,
      hint: 'Imports that failed or carry warnings',
      accent: 'var(--color-attention)',
    },
    {
      id: 'active',
      label: 'Active',
      count: summary.active,
      hint: 'Admitted into the agenda',
      accent: 'var(--color-active)',
    },
    {
      id: 'ready',
      label: 'Ready for admission',
      count: summary.planningReady,
      hint: 'Proposed with every required predecessor satisfied',
      accent: 'var(--color-ready)',
    },
    {
      id: 'blocked',
      label: 'Dependency-blocked',
      count: summary.dependencyBlocked,
      hint: 'Waiting on an unfinished required predecessor',
      accent: 'var(--color-blocked)',
    },
  ];
  return (
    <section className="regions" aria-label="Work summary">
      {regions.map((region) => (
        <article
          key={region.id}
          className="region"
          style={{ '--region-accent': region.accent } as CSSProperties}
        >
          <h3>{region.label}</h3>
          <span className="count">{region.count}</span>
          <p className="hint">{region.hint}</p>
        </article>
      ))}
    </section>
  );
}
