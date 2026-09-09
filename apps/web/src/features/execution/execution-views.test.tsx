import type {
  AgentRunDetailResponse,
  AgentRunSummary,
  RunEventEnvelope,
  SourceRepositorySummary,
  WorktreeDiffResponse,
  WorktreeSummary,
} from '@craftingtable/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegationPanel } from './DelegationPanel.js';
import { DiffView } from './DiffView.js';
import { RepositoriesPage } from './RepositoriesPage.js';
import { RunPage } from './RunPage.js';
import { remediationInput } from './remediation.js';

afterEach(cleanup);

const repository: SourceRepositorySummary = {
  id: 'repo-1',
  workspaceId: 'ws-1',
  displayName: 'craftingtable',
  rootPath: '/home/user/src/craftingtable',
  defaultBranch: 'main',
  registeredHeadSha: '0123456789abcdef0123456789abcdef01234567',
  status: 'active',
  registeredAt: '2026-09-04T10:00:00.000Z',
  registeredByUserId: 'user-1',
  version: 1,
} as SourceRepositorySummary;

const worktree: WorktreeSummary = {
  id: 'wt-1',
  workspaceId: 'ws-1',
  repositoryId: 'repo-1',
  projectId: 'project-1',
  workItemId: 'item-1',
  branchName: 'ct/aq-01-abcd1234',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  baseBranch: 'main',
  path: '/data/worktrees/craftingtable/aq-01-abcd1234',
  status: 'active',
  createdAt: '2026-09-04T10:05:00.000Z',
  createdByUserId: 'user-1',
  version: 1,
} as WorktreeSummary;

function run(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    repositoryId: 'repo-1',
    projectId: 'project-1',
    workItemId: 'item-1',
    backend: 'claude-code',
    role: 'implement',
    status: 'waiting',
    permissionMode: 'auto',
    createdAt: '2026-09-04T10:10:00.000Z',
    createdByUserId: 'user-1',
    turnCount: 2,
    costUsd: 1.25,
    outcomeSummary: 'Added the queue and tests.',
    version: 3,
    ...overrides,
  } as AgentRunSummary;
}

function event(sequence: number, partial: Partial<RunEventEnvelope>): RunEventEnvelope {
  return {
    sequence,
    id: `event-${sequence}`,
    workspaceId: 'ws-1',
    runId: 'run-1',
    occurredAt: '2026-09-04T10:11:00.000Z',
    ...partial,
  } as RunEventEnvelope;
}

describe('RepositoriesPage', () => {
  it('lists repositories, reports tools, and submits a registration', () => {
    const onRegister = vi.fn();
    render(
      <RepositoriesPage
        repositories={[
          repository,
          {
            ...repository,
            id: 'repo-2' as SourceRepositorySummary['id'],
            status: 'retired',
            displayName: 'old',
          },
        ]}
        status={{
          git: { available: true, executable: '/usr/bin/git' },
          backends: [{ kind: 'claude-code', label: 'Claude Code', available: false, models: [] }],
        }}
        canMutate={true}
        busy={false}
        onRegister={onRegister}
        onRetire={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Registered (1)' })).toBeDefined();
    expect(screen.getByText('/home/user/src/craftingtable')).toBeDefined();
    expect(screen.getByText(/Retired: old/)).toBeDefined();
    expect(screen.getByRole('note').textContent).toContain('A missing tool disables delegation');

    fireEvent.change(screen.getByLabelText(/Absolute path/), {
      target: { value: '  /home/user/src/other ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(onRegister).toHaveBeenCalledWith({ rootPath: '/home/user/src/other' });
  });
});

describe('DelegationPanel', () => {
  it('shows worktrees and runs, and launches with the chosen role and permissions', () => {
    const onLaunch = vi.fn();
    const onOpenRun = vi.fn();
    render(
      <DelegationPanel
        repositories={[repository]}
        worktrees={[worktree]}
        runs={[
          run(),
          run({ id: 'run-0' as AgentRunSummary['id'], status: 'finished', role: 'design' }),
        ]}
        mergeGates={{ 'wt-1': { mergeable: false, reason: 'no-review' } }}
        backends={[
          {
            kind: 'claude-code',
            label: 'Claude Code',
            available: true,
            models: [{ id: 'opus', label: 'Opus (current)' }],
          },
        ]}
        itemCompleted={false}
        canMutate={true}
        busy={false}
        onCreateWorktree={vi.fn()}
        onRemoveWorktree={vi.fn()}
        onMergeWorktree={vi.fn()}
        onLoadBranches={vi.fn()}
        onLaunch={onLaunch}
        onRemediate={vi.fn()}
        onOpenRun={onOpenRun}
        onOpenDiff={vi.fn()}
      />,
    );
    expect(screen.getAllByText('ct/aq-01-abcd1234').length).toBeGreaterThan(0);
    expect(screen.getByText('Needs a review run')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
    const table = screen.getByRole('table', { name: 'Agent runs' });
    expect(within(table).getByText('Awaiting your input')).toBeDefined();
    expect(within(table).getByText('Finished')).toBeDefined();
    expect(within(table).getAllByText('$1.25').length).toBe(2);

    const form = screen.getByRole('form', { name: 'Launch an agent' });
    fireEvent.change(within(form).getByLabelText('Role'), { target: { value: 'review' } });
    fireEvent.change(within(form).getByLabelText('Permissions'), {
      target: { value: 'edit-only' },
    });
    fireEvent.change(within(form).getByLabelText(/Instructions/), {
      target: { value: 'Focus on tests.' },
    });
    // The model picker offers the backend's list, then a free-text escape hatch.
    fireEvent.change(within(form).getByLabelText('Model'), { target: { value: 'opus' } });
    fireEvent.click(within(form).getByRole('button', { name: /Launch review run/ }));
    expect(onLaunch).toHaveBeenCalledWith({
      backend: 'claude-code',
      worktreeId: 'wt-1',
      role: 'review',
      permissionMode: 'edit-only',
      model: 'opus',
      instructions: 'Focus on tests.',
      parentRunId: 'run-0',
    });
    fireEvent.change(within(form).getByLabelText('Model'), { target: { value: '__custom__' } });
    fireEvent.change(within(form).getByLabelText('Model id'), {
      target: { value: 'claude-next-9' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /Launch review run/ }));
    expect(onLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'claude-next-9' }));
  });

  it('offers Merge with a chosen target only when the daemon reports the gate open', () => {
    const onMergeWorktree = vi.fn();
    const onLoadBranches = vi.fn();
    const onRemediate = vi.fn();
    const review = run({
      status: 'finished',
      role: 'review',
      verdict: 'mergeable',
      billing: 'subscription',
      resolvedModel: 'claude-fable-5-1',
      outcomeSummary: 'Review complete.\n\n1. Minor: rename the helper.\n2. Nit: typo.',
    });
    render(
      <DelegationPanel
        repositories={[repository]}
        worktrees={[worktree]}
        runs={[review]}
        mergeGates={{
          'wt-1': {
            mergeable: true,
            reason: 'ready',
            reviewRunId: 'run-1' as AgentRunSummary['id'],
          },
        }}
        branches={{ branches: ['aq-cont-1', 'ct/aq-01-abcd1234', 'main'], checkedOut: 'main' }}
        backends={[{ kind: 'claude-code', label: 'Claude Code', available: true, models: [] }]}
        itemCompleted={false}
        canMutate={true}
        busy={false}
        onCreateWorktree={vi.fn()}
        onRemoveWorktree={vi.fn()}
        onMergeWorktree={onMergeWorktree}
        onLoadBranches={onLoadBranches}
        onLaunch={vi.fn()}
        onRemediate={onRemediate}
        onOpenRun={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    expect(screen.getByText('Reviewed and mergeable')).toBeDefined();
    const table = screen.getByRole('table', { name: 'Agent runs' });
    expect(within(table).getByText('Mergeable')).toBeDefined();
    expect(within(table).getByText('claude-fable-5-1')).toBeDefined();
    // A subscription session reports an estimate, not a bill.
    expect(within(table).getByText('≈$1.25 (est.)')).toBeDefined();
    // Long outcomes are collapsed to their first line.
    const details = within(table).getByText('Review complete.').closest('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    // A review with a verdict can be handed to a remediation run.
    fireEvent.click(within(table).getByRole('button', { name: 'Remediate' }));
    expect(onRemediate).toHaveBeenCalledWith(review);

    fireEvent.click(screen.getByRole('button', { name: 'Merge…' }));
    expect(onLoadBranches).toHaveBeenCalledWith('repo-1');
    const form = screen.getByRole('form', { name: 'Merge target' });
    const input = within(form).getByLabelText('Merge into') as HTMLInputElement;
    expect(input.value).toBe('main');
    fireEvent.change(input, { target: { value: 'aq-cont-1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Merge' }));
    expect(onMergeWorktree).toHaveBeenCalledWith('wt-1', 'aq-cont-1');
  });

  it('cannot remove a worktree with a live run and disables launch without a backend', () => {
    render(
      <DelegationPanel
        repositories={[repository]}
        worktrees={[worktree]}
        runs={[run({ status: 'running' })]}
        mergeGates={{ 'wt-1': { mergeable: false, reason: 'run-live' } }}
        backends={[{ kind: 'claude-code', label: 'Claude Code', available: false, models: [] }]}
        itemCompleted={false}
        canMutate={true}
        busy={false}
        onCreateWorktree={vi.fn()}
        onRemoveWorktree={vi.fn()}
        onMergeWorktree={vi.fn()}
        onLoadBranches={vi.fn()}
        onLaunch={vi.fn()}
        onRemediate={vi.fn()}
        onOpenRun={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: /Launch implement run/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('note').textContent).toContain('No agent backend was found');
  });
});

describe('RunPage', () => {
  const detail: AgentRunDetailResponse = {
    run: run({ status: 'waiting' }),
    worktree,
    brief: '# Work item AQ-01: Establish the queue',
    eventCount: 4,
  } as AgentRunDetailResponse;

  it('renders the status, events, and a message box for a live run', () => {
    const onSend = vi.fn();
    render(
      <RunPage
        detail={detail}
        events={[
          event(1, { kind: 'user-message', payload: { text: 'brief text' } }),
          event(2, {
            kind: 'tool-call',
            payload: { toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, summary: 'ls' },
          }),
          event(3, { kind: 'assistant-message', payload: { text: 'Done with <script>' } }),
          event(4, {
            kind: 'turn-completed',
            payload: {
              outcome: 'success',
              resultText: 'ok',
              turns: 1,
              durationMs: 1500,
              model: 'resolved',
              tokenUsage: {
                inputTokens: 10,
                cachedInputTokens: 5,
                outputTokens: 2,
                reasoningOutputTokens: 1,
                totalTokens: 12,
              },
            },
          }),
        ]}
        connection="open"
        canMutate={true}
        busy={false}
        onSend={onSend}
        onEnd={vi.fn()}
        onCancel={vi.fn()}
        onOpenWorkItem={vi.fn()}
        onLoadDiff={vi.fn()}
        onCloseDiff={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Awaiting your input').length).toBeGreaterThan(0);
    expect(screen.getByText('Bash: ls')).toBeDefined();
    expect(screen.getByTestId('run-feed').textContent).toContain(
      'tokens: 12 (10 input, 5 cached, 2 output)',
    );
    expect(screen.getByText('Done with <script>')).toBeDefined();
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show brief' }));
    expect(screen.getByTestId('run-brief').textContent).toContain('# Work item AQ-01');

    fireEvent.change(screen.getByLabelText('Message to the agent'), {
      target: { value: 'Add a test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('Add a test');
  });

  it('filters the feed by group and keeps tool output collapsed by default', () => {
    render(
      <RunPage
        detail={detail}
        events={[
          event(1, {
            kind: 'notice',
            payload: { category: 'task', message: 'Background task started: tests' },
          }),
          event(2, {
            kind: 'tool-call',
            payload: { toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, summary: 'ls' },
          }),
          event(3, {
            kind: 'tool-result',
            payload: { toolUseId: 't1', content: 'a.ts\nb.ts', isError: false, truncated: false },
          }),
          event(4, { kind: 'assistant-message', payload: { text: 'All good.' } }),
        ]}
        connection="open"
        canMutate={true}
        busy={false}
        onSend={vi.fn()}
        onEnd={vi.fn()}
        onCancel={vi.fn()}
        onOpenWorkItem={vi.fn()}
        onLoadDiff={vi.fn()}
        onCloseDiff={vi.fn()}
      />,
    );
    const feed = screen.getByTestId('run-feed');
    expect(within(feed).getByText('Background task started: tests')).toBeDefined();
    // Tool output is inside a collapsed details element.
    const details = feed.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /^Notices/ }));
    expect(within(feed).queryByText('Background task started: tests')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Tools/ }));
    expect(within(feed).queryByText('Bash: ls')).toBeNull();
    expect(within(feed).getByText('All good.')).toBeDefined();
  });

  it('offers remediation on a review with a verdict', () => {
    const onRemediate = vi.fn();
    render(
      <RunPage
        detail={{
          ...detail,
          run: run({ status: 'finished', role: 'review', verdict: 'changes-requested' }),
        }}
        events={[]}
        connection="open"
        canMutate={true}
        busy={false}
        onSend={vi.fn()}
        onEnd={vi.fn()}
        onCancel={vi.fn()}
        onOpenWorkItem={vi.fn()}
        onLoadDiff={vi.fn()}
        onCloseDiff={vi.fn()}
        onRemediate={onRemediate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remediate findings' }));
    expect(onRemediate).toHaveBeenCalledOnce();
  });

  it('hides the controls once the run is terminal', () => {
    render(
      <RunPage
        detail={{ ...detail, run: run({ status: 'finished' }) }}
        events={[]}
        connection="disconnected"
        canMutate={true}
        busy={false}
        onSend={vi.fn()}
        onEnd={vi.fn()}
        onCancel={vi.fn()}
        onOpenWorkItem={vi.fn()}
        onLoadDiff={vi.fn()}
        onCloseDiff={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
    expect(screen.queryByLabelText('Message to the agent')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('DiffView', () => {
  it('renders files, totals, and the patch as text', () => {
    const diff: WorktreeDiffResponse = {
      worktree,
      baseSha: worktree.baseSha,
      headSha: 'fedcba9876543210fedcba9876543210fedcba98',
      commits: [
        {
          sha: 'fedcba9876543210fedcba9876543210fedcba98',
          subject: 'add queue',
          authoredAt: '2026-09-04T10:20:00.000Z',
        },
      ],
      files: [
        { path: 'src/queue.ts', status: 'added', additions: 40, deletions: 0, binary: false },
        { path: 'README.md', status: 'modified', additions: 2, deletions: 1, binary: false },
      ],
      patch: 'diff --git a/README.md b/README.md\n@@ -1 +1,2 @@\n-old\n+new <b>bold</b>\n',
      patchTruncated: true,
    } as WorktreeDiffResponse;
    render(<DiffView diff={diff} />);
    expect(screen.getByText(/2 files · \+42 −1/)).toBeDefined();
    expect(screen.getByText('add queue')).toBeDefined();
    expect(screen.getByText('src/queue.ts')).toBeDefined();
    expect(screen.getByTestId('diff-text').textContent).toContain('+new <b>bold</b>');
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('truncated');
  });
});

it('offers per-agent models, resets the model on switch, and marks unavailable agents', () => {
  const onLaunch = vi.fn();
  const props = {
    repositories: [repository],
    worktrees: [worktree],
    runs: [],
    mergeGates: {},
    itemCompleted: false,
    canMutate: true,
    busy: false,
    onCreateWorktree: vi.fn(),
    onRemoveWorktree: vi.fn(),
    onMergeWorktree: vi.fn(),
    onLoadBranches: vi.fn(),
    onLaunch,
    onRemediate: vi.fn(),
    onOpenRun: vi.fn(),
    onOpenDiff: vi.fn(),
  };
  const claude = {
    kind: 'claude-code' as const,
    label: 'Claude Code',
    available: true,
    models: [{ id: 'opus', label: 'Opus' }],
  };
  const codex = {
    kind: 'codex' as const,
    label: 'Codex',
    available: true,
    models: [{ id: 'gpt-5.6-luna', label: 'Luna' }],
  };
  const view = render(<DelegationPanel {...props} backends={[claude, codex]} />);
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });
  fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } });
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
  expect(screen.queryByRole('option', { name: 'Opus' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-luna' } });
  fireEvent.click(screen.getByRole('button', { name: 'Launch implement run' }));
  expect(onLaunch).toHaveBeenCalledWith(
    expect.objectContaining({ backend: 'codex', model: 'gpt-5.6-luna' }),
  );
  view.rerender(<DelegationPanel {...props} backends={[claude, { ...codex, available: false }]} />);
  expect(
    (screen.getByRole('option', { name: 'Codex (not found)' }) as HTMLOptionElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Launch implement run' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  view.rerender(<DelegationPanel {...props} backends={[claude]} />);
  expect(screen.queryByLabelText('Agent')).toBeNull();
});

it('remediates using the latest finished implementer in the same worktree, otherwise the review', () => {
  const review = run({ backend: 'codex', role: 'review', model: 'gpt-5.6-luna' });
  const implementer = run({
    id: 'impl' as AgentRunSummary['id'],
    status: 'finished',
    model: 'opus',
  });
  expect(remediationInput(review, [review, implementer])).toMatchObject({
    backend: 'claude-code',
    model: 'opus',
    parentRunId: review.id,
  });
  expect(
    remediationInput(review, [
      run({ status: 'failed' }),
      { ...implementer, worktreeId: 'other' as AgentRunSummary['worktreeId'] },
    ]),
  ).toMatchObject({ backend: 'codex', model: 'gpt-5.6-luna' });
});
