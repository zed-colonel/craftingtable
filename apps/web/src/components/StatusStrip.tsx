import type { CSSProperties, ReactNode } from 'react';

export interface StatusFact {
  readonly label: string;
  readonly value: ReactNode;
  /** Identifiers, branches, commits, models, and numbers are monospace. */
  readonly mono?: boolean;
  /** A semantic colour token for state values; the label stays neutral. */
  readonly accent?: string;
}

/**
 * A row of labelled facts, replacing "a · b · c" meta lines. Every value has a
 * visible label, wraps as a unit on narrow screens, and never relies on colour
 * alone to carry state.
 */
export function StatusStrip({
  facts,
  label,
  compact,
}: {
  facts: readonly StatusFact[];
  /** Accessible name for the group when the strip stands alone. */
  label?: string;
  /** Tighter spacing for use inside list rows and cards. */
  compact?: boolean;
}) {
  const shown = facts.filter((fact) => fact.value !== undefined && fact.value !== '');
  if (shown.length === 0) {
    return null;
  }
  return (
    <dl className={`status-strip${compact ? ' compact' : ''}`} aria-label={label}>
      {shown.map((fact) => (
        <div key={fact.label} className="status-fact">
          <dt>{fact.label}</dt>
          <dd
            className={fact.mono ? 'mono' : undefined}
            style={
              fact.accent === undefined ? undefined : ({ color: fact.accent } as CSSProperties)
            }
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
