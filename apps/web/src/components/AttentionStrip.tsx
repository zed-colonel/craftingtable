import type { WorkCycle } from '@craftingtable/domain';
import { CYCLE_STATUS_LABELS } from '../lib/execution-labels.js';
import { Section } from './Section.js';

/** Cycles that stopped for an operator decision: merge approval or attention. */
export function attentionCycles(cycles: readonly WorkCycle[]): readonly WorkCycle[] {
  return cycles.filter(
    (cycle) =>
      !cycle.scopeReviewWait &&
      (cycle.status === 'needs-attention' || cycle.status === 'awaiting-merge'),
  );
}

/**
 * What automation is waiting on the operator for.
 *
 * On the dashboard it is the first section of the page. On every other
 * workspace page it is one compact line per cycle, so a notification deep link
 * that lands on an item page still shows what else is waiting.
 */
export function AttentionStrip({
  cycles,
  variant,
  onOpen,
}: {
  cycles: readonly WorkCycle[];
  variant: 'strip' | 'section';
  onOpen: (cycle: WorkCycle) => void;
}) {
  const attention = attentionCycles(cycles);
  if (attention.length === 0) {
    return null;
  }
  const rows = attention.map((cycle) => (
    <li key={cycle.id} className="attention-row">
      <button type="button" className="text-button" onClick={() => onOpen(cycle)}>
        {cycle.workItemSourceId}: {CYCLE_STATUS_LABELS[cycle.status]}
      </button>
      <span className="attention-reason">{cycle.reason}</span>
    </li>
  ));
  if (variant === 'section') {
    return (
      <Section
        title="Needs your attention"
        label="Cycles needing attention"
        count={attention.length}
        tone="attention"
        summary="Automation has stopped for a decision only you can make."
      >
        <ul className="attention-list">{rows}</ul>
      </Section>
    );
  }
  return (
    <section className="attention-strip" aria-label="Cycles needing attention">
      <ul className="attention-list compact">{rows}</ul>
    </section>
  );
}
