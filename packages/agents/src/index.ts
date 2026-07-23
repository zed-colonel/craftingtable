import type { AgentEventEnvelope } from '@craftingtable/contracts';

/**
 * CT-01 deliberately defines only the subset of the eventual backend contract
 * needed for the fake event path: self-description and a normalized event
 * stream. Directives, approvals, inspection, and cancellation from the
 * implementation plan (§8.1) are deferred; see ADR-007.
 */
export interface BackendDescriptor {
  id: string;
  label: string;
  version: string;
  /** CT-01 backends are always simulated; the UI badge derives from this. */
  simulated: true;
}

export interface AgentBackend {
  describe(): BackendDescriptor;
  /** Yields normalized envelopes until the stream ends or `signal` aborts. */
  streamEvents(signal: AbortSignal): AsyncIterable<AgentEventEnvelope>;
}
