/** Re-verify for a roadmap item whose evidence is no longer current; the server decides eligibility. */
export function ReverifyItem({
  reverifiable,
  canMutate,
  busy,
  onReverify,
}: {
  reverifiable: boolean;
  canMutate: boolean;
  busy: boolean;
  onReverify: () => void;
}) {
  if (!reverifiable || !canMutate) return null;
  return (
    <>
      <button type="button" className="secondary-button" disabled={busy} onClick={onReverify}>
        Re-verify
      </button>{' '}
      <span className="hint">
        Runs a fresh independent review with the assigned reviewer. Does not resume the roadmap.
      </span>
    </>
  );
}
