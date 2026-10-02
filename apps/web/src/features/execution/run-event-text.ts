import type { RunEventEnvelope } from '@craftingtable/contracts';
import { BILLING_LABELS, RUN_STATUS_LABELS } from '../../lib/execution-labels.js';

/** A run event's heading. */
export function eventTitle(event: RunEventEnvelope): string {
  switch (event.kind) {
    case 'session-started':
      return `Session started · ${event.payload.model}`;
    case 'user-message':
      return 'You';
    case 'assistant-message':
      return 'Agent';
    case 'tool-call':
      return `${event.payload.name}: ${event.payload.summary}`;
    case 'tool-result':
      return event.payload.isError ? 'Tool error' : 'Tool result';
    case 'turn-completed':
      return event.payload.outcome === 'success' ? 'Turn completed' : 'Turn ended with an error';
    case 'notice':
      return `Notice (${event.payload.category})`;
    case 'stderr':
      return 'Backend stderr';
    case 'run-finished':
      return `Run ${RUN_STATUS_LABELS[event.payload.status].toLowerCase()}`;
  }
}

/** A run event's text, if it has one. */
export function eventBody(event: RunEventEnvelope): string | undefined {
  switch (event.kind) {
    case 'session-started':
      return `${event.payload.backend} session ${event.payload.backendSessionId} (${
        BILLING_LABELS[event.payload.billing]
      }) in ${event.payload.cwd}`;
    case 'user-message':
    case 'assistant-message':
    case 'stderr':
      return event.payload.text;
    case 'tool-call':
      return JSON.stringify(event.payload.input, null, 2);
    case 'tool-result':
      return event.payload.content;
    case 'turn-completed':
      return `${event.payload.resultText}\n\nturns: ${event.payload.turns} · duration: ${(
        event.payload.durationMs / 1000
      ).toFixed(1)}s${
        event.payload.costUsd === undefined
          ? ''
          : ` · cost so far: $${event.payload.costUsd.toFixed(2)}`
      }${event.payload.tokenUsage === undefined ? '' : ` · tokens: ${event.payload.tokenUsage.totalTokens.toLocaleString()} (${event.payload.tokenUsage.inputTokens.toLocaleString()} input, ${event.payload.tokenUsage.cachedInputTokens.toLocaleString()} cached, ${event.payload.tokenUsage.outputTokens.toLocaleString()} output)`}`;
    case 'notice':
      return event.payload.message;
    case 'run-finished':
      return (
        event.payload.message ??
        (event.payload.exitCode === undefined ? undefined : `exit code ${event.payload.exitCode}`)
      );
  }
}
