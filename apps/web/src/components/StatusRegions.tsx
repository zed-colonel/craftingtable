import type { CSSProperties } from 'react';

interface Region {
  id: string;
  label: string;
  count: number;
  hint: string;
  accentVar: string;
}

export interface StatusRegionsProps {
  activeRuns: number;
  readyRuns: number;
}

/**
 * Visual placeholders for the eventual dashboard regions. Counts for
 * `Active`/`Ready` derive from the simulated run; the rest have no data source
 * yet and say so instead of pretending.
 */
export function StatusRegions({ activeRuns, readyRuns }: StatusRegionsProps) {
  const regions: Region[] = [
    {
      id: 'needs-attention',
      label: 'Needs attention',
      count: 0,
      hint: 'Nothing simulated yet',
      accentVar: 'var(--color-attention)',
    },
    {
      id: 'active',
      label: 'Active',
      count: activeRuns,
      hint: 'Simulated agent runs',
      accentVar: 'var(--color-active)',
    },
    {
      id: 'ready',
      label: 'Ready',
      count: readyRuns,
      hint: 'Simulated completions',
      accentVar: 'var(--color-ready)',
    },
    {
      id: 'blocked',
      label: 'Blocked',
      count: 0,
      hint: 'Nothing simulated yet',
      accentVar: 'var(--color-blocked)',
    },
  ];

  return (
    <section className="regions" aria-label="Work summary">
      {regions.map((region) => (
        <article
          key={region.id}
          className="region"
          style={{ '--region-accent': region.accentVar } as CSSProperties}
        >
          <h3>{region.label}</h3>
          <span className="count">{region.count}</span>
          <p className="hint">{region.hint}</p>
        </article>
      ))}
    </section>
  );
}
