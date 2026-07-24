import type { ConnectionState } from '../lib/workspace-projection.js';

const LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

export function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  return (
    <span className="badge badge-connection" data-connection={connection} role="status">
      <span className="badge-dot" aria-hidden="true" />
      {LABELS[connection]}
    </span>
  );
}
