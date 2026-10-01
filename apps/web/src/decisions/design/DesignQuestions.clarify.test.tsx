import type { DesignRecoveryPreview } from '@craftingtable/contracts';
import {
  asWorkspaceId,
  CYCLE_STEPS,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
  type WorkItemId,
} from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NavigationProvider } from '../../lib/navigation.js';
import { buildPath, parseRoute, type Route } from '../../lib/route.js';
import { previewDesignRecovery } from './design-api.js';
import { DesignQuestions } from './DesignQuestions.js';

vi.mock('./design-api.js', () => ({
  previewDesignRecovery: vi.fn(),
  recoverDesign: vi.fn(),
}));
vi.mock('../../features/planning/SharedDecisionInbox.js', () => ({
  SharedDecisionInbox: () => null,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const cycle = {
  id: 'cycle',
  workspaceId: 'ws',
  workItemId: 'item',
  worktreeId: 'tree',
  currentRunId: 'design',
  version: 2,
  step: 'design',
  status: 'needs-attention',
  policy: DEFAULT_COMPLETION_POLICY,
  profiles: Object.fromEntries(
    CYCLE_STEPS.map((step) => [
      step,
      { backend: 'claude-code', permissionMode: 'auto', model: 'prior-model' },
    ]),
  ),
} as unknown as WorkCycle;
const backends = [
  {
    kind: 'claude-code' as const,
    label: 'Claude Code',
    available: true,
    executable: 'claude',
    models: [],
  },
];
const previewFor = (checkpointId: string) =>
  ({
    expectedVersion: 2,
    sourceRunId: cycle.currentRunId,
    questions: 'Q',
    facts: 'F',
    snapshotDigest: 'a'.repeat(64),
    sources: [],
    notices: [],
    decisionInbox: { decisions: [{ checkpointId }] },
  }) as unknown as DesignRecoveryPreview;

/** The route SharedDecisionInbox's "clarify" Link produces, after a real address round trip. */
function clarifyRoute(checkpointId: string): Route {
  const built = buildPath({
    name: 'work-item',
    workspaceId: asWorkspaceId('ws'),
    workItemId: 'item' as WorkItemId,
    focus: `clarify-architecture-${checkpointId}`,
  });
  const url = new URL(built, 'http://x.invalid');
  return parseRoute(url.pathname, url.search, url.hash);
}

function Panel({ route }: { route: Route }) {
  return (
    <NavigationProvider value={{ route, navigate: () => undefined }}>
      <DesignQuestions
        cycle={cycle}
        backends={backends}
        csrfToken="csrf"
        onChanged={() => undefined}
      />
    </NavigationProvider>
  );
}

it('prepares the clarification draft for a checkpoint id with a space (encoding round trip)', async () => {
  vi.mocked(previewDesignRecovery).mockResolvedValue(previewFor('ADR 7'));
  render(<Panel route={clarifyRoute('ADR 7')} />);
  await waitFor(() => expect(previewDesignRecovery).toHaveBeenCalled());
  const guidance = (await screen.findByLabelText('Answers and guidance')) as HTMLTextAreaElement;
  //
  expect(guidance.value).toContain('Clarify ADR 7');
});

it('does not overwrite an edited clarification draft when Back returns to the clarify focus', async () => {
  vi.mocked(previewDesignRecovery).mockResolvedValue(previewFor('ADR-7'));
  const clarify = clarifyRoute('ADR-7');
  const { rerender } = render(<Panel route={clarify} />);
  const guidance = (await screen.findByLabelText('Answers and guidance')) as HTMLTextAreaElement;
  await waitFor(() => expect(guidance.value).toContain('Clarify ADR-7'));
  fireEvent.change(guidance, { target: { value: 'My own edited guidance.' } });
  // The operator follows an in-page anchor (<a href="#slices">, SectionNav): hashchange sets focus.
  rerender(<Panel route={{ ...clarify, focus: 'slices' } as Route} />);
  // ...and presses Back: the address returns to #clarify-architecture-ADR-7.
  rerender(<Panel route={clarify} />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  //
  expect((screen.getByLabelText('Answers and guidance') as HTMLTextAreaElement).value).toBe(
    'My own edited guidance.',
  );
  expect(previewDesignRecovery).toHaveBeenCalledTimes(1);
});
