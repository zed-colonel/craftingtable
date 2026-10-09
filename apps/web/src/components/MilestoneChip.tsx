/**
 * A milestone chip: a slice's or work item's milestone ("started", "merged", "verified"), with
 * whether it is met in words, never by colour alone. The roadmap board (R-E3b) makes it a button
 * that selects the milestone; the work item's slice strip (R-E4) shows it as it is.
 */
export function MilestoneChip({
  state,
  met,
  label,
  pressed,
  onSelect,
}: {
  state: string;
  met: boolean;
  /** The chip's accessible name when it is a button: what it selects. */
  label?: string;
  pressed?: boolean;
  onSelect?: () => void;
}) {
  const className = `board-chip${met ? ' board-chip-met' : ''}`;
  const text = `${met ? '✓ ' : ''}${state}`;
  if (onSelect)
    return (
      <button
        type="button"
        className={className}
        aria-pressed={pressed}
        aria-label={label ?? `${state}: ${met ? 'met' : 'not met'}`}
        onClick={onSelect}
      >
        {text}
      </button>
    );
  return (
    <span className={`${className} board-chip-static`}>
      {text}
      <span className="visually-hidden">{met ? ' (met)' : ' (not met)'}</span>
    </span>
  );
}
