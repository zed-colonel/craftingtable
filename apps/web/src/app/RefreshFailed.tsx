/**
 * A page's read failed (R-D4 4b review F3): the page says so, and keeps whatever it last read,
 * as the page round's warning did.
 */
export function RefreshFailed({ failed }: { failed: boolean }) {
  return failed ? (
    <p className="warning-state" role="alert">
      The latest refresh failed. The last committed state remains visible.
    </p>
  ) : null;
}
