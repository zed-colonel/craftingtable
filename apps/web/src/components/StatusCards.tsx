import type { WorkspaceSnapshotResponse } from '@craftingtable/contracts';
import type { CSSProperties } from 'react';
import type { AgendaFilter } from '../lib/route.js';

export type StatusCardTarget =
  | { readonly kind: 'runs' }
  | { readonly kind: 'agenda'; readonly filter: AgendaFilter }
  | { readonly kind: 'import' };

interface StatusCard {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly hint: string;
  readonly accent: string;
  readonly target: StatusCardTarget;
}

/**
 * The dashboard's summary row. Every card is a button that opens the list it
 * counts, so a number is never a dead end.
 */
export function StatusCards({
  summary,
  onOpen,
}: {
  summary: WorkspaceSnapshotResponse['statusSummary'];
  onOpen: (target: StatusCardTarget) => void;
}) {
  const cards: readonly StatusCard[] = [
    {
      id: 'live-runs',
      label: 'Live runs',
      count: summary.liveRuns,
      hint: 'Agents working or waiting for you',
      accent: 'var(--color-active)',
      target: { kind: 'runs' },
    },
    {
      id: 'in-agenda',
      label: 'In agenda',
      count: summary.active,
      hint: 'Admitted, not yet completed',
      accent: 'var(--color-accent)',
      target: { kind: 'agenda', filter: 'admitted' },
    },
    {
      id: 'ready',
      label: 'Ready for admission',
      count: summary.planningReady,
      hint: 'Proposed with every required predecessor completed',
      accent: 'var(--color-ready)',
      target: { kind: 'agenda', filter: 'planning-ready' },
    },
    {
      id: 'blocked',
      label: 'Dependency-blocked',
      count: summary.dependencyBlocked,
      hint: 'Waiting on an unfinished required predecessor',
      accent: 'var(--color-blocked)',
      target: { kind: 'agenda', filter: 'dependency-blocked' },
    },
    {
      id: 'completed',
      label: 'Completed',
      count: summary.completed,
      hint: 'Merged or marked done',
      accent: 'var(--color-done)',
      target: { kind: 'agenda', filter: 'completed' },
    },
    ...(summary.needsAttention > 0
      ? [
          {
            id: 'needs-attention',
            label: 'Needs attention',
            count: summary.needsAttention,
            hint: 'Imports that failed or carry warnings',
            accent: 'var(--color-attention)',
            target: { kind: 'import' } as const,
          },
        ]
      : []),
  ];
  return (
    <section className="status-cards" aria-label="Work summary">
      {cards.map((card) => (
        <button
          type="button"
          key={card.id}
          className="status-card"
          style={{ '--card-accent': card.accent } as CSSProperties}
          onClick={() => onOpen(card.target)}
        >
          <span className="count">{card.count}</span>
          <span className="label">{card.label}</span>
          <span className="hint">{card.hint}</span>
        </button>
      ))}
    </section>
  );
}
