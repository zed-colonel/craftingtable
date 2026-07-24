import type { WorkspaceSnapshotResponse } from '@craftingtable/contracts';
import type { CSSProperties } from 'react';

export function StatusRegions({
  summary,
}: {
  summary: WorkspaceSnapshotResponse['statusSummary'];
}) {
  const regions = [
    {
      id: 'needs-attention',
      label: 'Needs attention',
      count: summary.needsAttention,
      hint: 'No executable work in CT-02',
      accent: 'var(--color-attention)',
    },
    {
      id: 'active',
      label: 'Active',
      count: summary.active,
      hint: 'No executable work in CT-02',
      accent: 'var(--color-active)',
    },
    {
      id: 'ready',
      label: 'Ready',
      count: summary.ready,
      hint: 'No executable work in CT-02',
      accent: 'var(--color-ready)',
    },
    {
      id: 'blocked',
      label: 'Blocked',
      count: summary.blocked,
      hint: 'No executable work in CT-02',
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
