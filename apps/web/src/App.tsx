import { ActivityPanel } from './components/ActivityPanel.js';
import { ConnectionBadge } from './components/ConnectionBadge.js';
import { SimulatedBadge } from './components/SimulatedBadge.js';
import { StatusRegions } from './components/StatusRegions.js';
import { useEventStream } from './lib/useEventStream.js';

export function App() {
  const { connection, events, invalidEventCount } = useEventStream();

  const startedRuns = events.filter((event) => event.kind === 'run-started').length;
  const completedRuns = events.filter((event) => event.kind === 'completion-proposed').length;

  return (
    <div className="shell">
      <aside className="rail">
        <span className="rail-mark" aria-hidden="true">
          Ct
        </span>
        <nav className="rail-nav" aria-label="Primary">
          <a className="rail-link" href="/" aria-current="page">
            Home
          </a>
        </nav>
      </aside>

      <main className="main">
        <header className="masthead">
          <div>
            <h1>Demo workspace</h1>
            <p className="subtitle">
              CT-01 executable skeleton — a supervisory dashboard preview fed by a fake agent
              backend and a fake Git service.
            </p>
          </div>
          <div className="masthead-status">
            <ConnectionBadge connection={connection} />
            <SimulatedBadge />
          </div>
        </header>

        <StatusRegions activeRuns={startedRuns - completedRuns} readyRuns={completedRuns} />

        <ActivityPanel
          connection={connection}
          events={events}
          invalidEventCount={invalidEventCount}
        />
      </main>
    </div>
  );
}
