import type {
  AgentRunDetailResponse,
  AgentRunProfileEntry,
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
import { handoffDefaults, handoffTarget } from './handoff.js';

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
const profiles: readonly AgentRunProfileEntry[] = [
  { role: 'design', backend: 'claude-code', permissionMode: 'auto', stored: false },
  {
    role: 'implement',
    backend: 'codex',
    model: 'gpt-5.6-luna',
    permissionMode: 'edit-only',
    stored: true,
  },
  { role: 'review', backend: 'claude-code', model: 'opus', permissionMode: 'auto', stored: true },
];

function panelProps(overrides: Partial<Parameters<typeof DelegationPanel>[0]> = {}) {
  return {
    repositories: [repository],
    worktrees: [worktree],
    runs: [] as readonly AgentRunSummary[],
    mergeGates: {},
    backends: [claude, codex],
    profiles,
    itemCompleted: false,
    canMutate: true,
    busy: false,
    onCreateWorktree: vi.fn(),
    onRemoveWorktree: vi.fn(),
    onMergeWorktree: vi.fn(),
    onLoadBranches: vi.fn(),
    onLaunch: vi.fn(),
    onOpenRun: vi.fn(),
    onOpenDiff: vi.fn(),
    ...overrides,
  };
}

describe('run profiles', () => {
  it('pre-fills the launch form from the role profile and follows role changes', () => {
    render(<DelegationPanel {...panelProps()} />);
    const form = screen.getByRole('form', { name: 'Launch an agent' });
    expect((within(form).getByLabelText('Agent') as HTMLSelectElement).value).toBe('codex');
    expect((within(form).getByLabelText('Model') as HTMLSelectElement).value).toBe('gpt-5.6-luna');
    expect((within(form).getByLabelText('Permissions') as HTMLSelectElement).value).toBe(
      'edit-only',
    );
    fireEvent.change(within(form).getByLabelText('Role'), { target: { value: 'review' } });
    expect((within(form).getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude-code');
    expect((within(form).getByLabelText('Model') as HTMLSelectElement).value).toBe('opus');
    expect((within(form).getByLabelText('Permissions') as HTMLSelectElement).value).toBe('auto');
  });

  it('leaves the operator’s agent choice alone when the new role has no stored profile', () => {
    const onLaunch = vi.fn();
    render(<DelegationPanel {...panelProps({ onLaunch })} />);
    const form = screen.getByRole('form', { name: 'Launch an agent' });
    // Start from the stored review profile (Claude), then pick Codex by hand.
    fireEvent.change(within(form).getByLabelText('Role'), { target: { value: 'review' } });
    fireEvent.change(within(form).getByLabelText('Agent'), { target: { value: 'codex' } });
    // The design profile is the daemon default, not a stored preference: Codex stays.
    fireEvent.change(within(form).getByLabelText('Role'), { target: { value: 'design' } });
    expect((within(form).getByLabelText('Agent') as HTMLSelectElement).value).toBe('codex');
    // A stored profile still applies.
    fireEvent.change(within(form).getByLabelText('Role'), { target: { value: 'review' } });
    expect((within(form).getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude-code');
    expect((within(form).getByLabelText('Model') as HTMLSelectElement).value).toBe('opus');
  });

  it('follows the previous run when the target role has only the daemon default', () => {
    const parent = run({ backend: 'codex', resolvedModel: 'gpt-5.6-luna' });
    const defaultsOnly: readonly AgentRunProfileEntry[] = [
      { role: 'implement', backend: 'claude-code', permissionMode: 'auto', stored: false },
    ];
    expect(handoffDefaults('implement', defaultsOnly, parent)).toEqual({
      backend: 'codex',
      model: 'gpt-5.6-luna',
      permissionMode: 'auto',
    });
    // Remediation without a stored profile returns to the previous implementer, not
    // to the reviewer that found the problems.
    const review = run({
      id: 'review-1' as AgentRunSummary['id'],
      role: 'review',
      status: 'finished',
      backend: 'codex',
    });
    const implementer = run({
      id: 'impl-1' as AgentRunSummary['id'],
      role: 'implement',
      status: 'finished',
      backend: 'claude-code',
      resolvedModel: 'opus',
    });
    expect(handoffDefaults('implement', defaultsOnly, review, [review, implementer])).toEqual({
      backend: 'claude-code',
      model: 'opus',
      permissionMode: 'auto',
    });
    expect(handoffDefaults('implement', defaultsOnly, review, [review])).toMatchObject({
      backend: 'codex',
    });
  });

  it('opens a handoff form from Remediate, pre-filled from the implement profile with an override', () => {
    const onLaunch = vi.fn();
    const review = run({
      id: 'review-1' as AgentRunSummary['id'],
      status: 'finished',
      role: 'review',
      verdict: 'changes-requested',
    });
    const implementer = run({
      id: 'impl-1' as AgentRunSummary['id'],
      status: 'finished',
      role: 'implement',
      backend: 'claude-code',
      resolvedModel: 'opus',
    });
    render(<DelegationPanel {...panelProps({ runs: [review, implementer], onLaunch })} />);
    const table = screen.getByRole('table', { name: 'Agent runs' });
    fireEvent.click(within(table).getByRole('button', { name: 'Remediate' }));
    const form = screen.getByRole('form', { name: 'Remediate with' });
    expect((within(form).getByLabelText('Agent') as HTMLSelectElement).value).toBe('codex');
    expect((within(form).getByLabelText('Model') as HTMLSelectElement).value).toBe('gpt-5.6-luna');
    // The previous implementer differs from the profile, so the form says so.
    expect(within(form).getByText(/last implement run here used Claude Code · opus/)).toBeDefined();
    fireEvent.change(within(form).getByLabelText('Agent'), { target: { value: 'claude-code' } });
    fireEvent.change(within(form).getByLabelText('Model'), { target: { value: 'opus' } });
    // Remediation is where guidance matters most: which findings, and whether nits count.
    fireEvent.change(within(form).getByLabelText(/Instructions for this run/), {
      target: { value: 'Address findings 1 and 3 only; skip the nits.  ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Launch' }));
    expect(onLaunch).toHaveBeenCalledWith({
      backend: 'claude-code',
      worktreeId: 'wt-1',
      role: 'implement',
      permissionMode: 'edit-only',
      model: 'opus',
      instructions: 'Address findings 1 and 3 only; skip the nits.',
      parentRunId: 'review-1',
    });
    expect(screen.queryByRole('form', { name: 'Remediate with' })).toBeNull();
  });

  it('opens a handoff form from Implement on a finished design run', () => {
    const onLaunch = vi.fn();
    const design = run({
      id: 'design-1' as AgentRunSummary['id'],
      status: 'finished',
      role: 'design',
    });
    render(
      <DelegationPanel
        {...panelProps({
          runs: [design, run({ id: 'live-1' as AgentRunSummary['id'], role: 'design' })],
          onLaunch,
        })}
      />,
    );
    const table = screen.getByRole('table', { name: 'Agent runs' });
    expect(within(table).getAllByRole('button', { name: 'Implement' })).toHaveLength(1);
    fireEvent.click(within(table).getByRole('button', { name: 'Implement' }));
    const form = screen.getByRole('form', { name: 'Implement with' });
    fireEvent.click(within(form).getByRole('button', { name: 'Launch' }));
    expect(onLaunch).toHaveBeenCalledWith({
      backend: 'codex',
      worktreeId: 'wt-1',
      role: 'implement',
      permissionMode: 'edit-only',
      model: 'gpt-5.6-luna',
      parentRunId: 'design-1',
    });
  });

  it('hands off from the run page through the same form', () => {
    const onHandoff = vi.fn();
    render(
      <RunPage
        detail={
          {
            run: run({ status: 'finished', role: 'review', verdict: 'changes-requested' }),
            worktree,
            brief: '# Work item AQ-01',
            eventCount: 1,
          } as AgentRunDetailResponse
        }
        events={[]}
        connection="open"
        backends={[claude, codex]}
        profiles={profiles}
        canMutate={true}
        busy={false}
        onSend={vi.fn()}
        onEnd={vi.fn()}
        onCancel={vi.fn()}
        onOpenWorkItem={vi.fn()}
        onLoadDiff={vi.fn()}
        onCloseDiff={vi.fn()}
        onHandoff={onHandoff}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remediate findings' }));
    const form = screen.getByRole('form', { name: 'Remediate with' });
    fireEvent.change(within(form).getByLabelText('Permissions'), {
      target: { value: 'unrestricted' },
    });
    fireEvent.change(within(form).getByLabelText(/Instructions for this run/), {
      target: { value: 'Fix the blocking finding first.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Launch' }));
    expect(onHandoff).toHaveBeenCalledWith({
      backend: 'codex',
      worktreeId: 'wt-1',
      role: 'implement',
      permissionMode: 'unrestricted',
      model: 'gpt-5.6-luna',
      instructions: 'Fix the blocking finding first.',
      parentRunId: 'run-1',
    });
  });

  it('defaults a handoff to the role profile, else to the parent run', () => {
    const parent = run({
      backend: 'codex',
      resolvedModel: 'gpt-5.6-luna',
      permissionMode: 'edit-only',
    });
    expect(handoffDefaults('implement', profiles, parent)).toEqual({
      backend: 'codex',
      model: 'gpt-5.6-luna',
      permissionMode: 'edit-only',
    });
    expect(handoffDefaults('implement', [], parent)).toEqual({
      backend: 'codex',
      model: 'gpt-5.6-luna',
      permissionMode: 'auto',
    });
    expect(handoffDefaults('implement', [], run({ resolvedModel: 'default' }))).toEqual({
      backend: 'claude-code',
      permissionMode: 'auto',
    });
  });
});

describe('review handoff', () => {
  it('names the handoff each run offers', () => {
    expect(handoffTarget(run({ role: 'implement', status: 'finished' }))).toMatchObject({
      role: 'review',
      label: 'Review with',
      button: 'Review',
      pageButton: 'Review this implementation',
    });
    expect(handoffTarget(run({ role: 'implement', status: 'waiting' }))).toBeUndefined();
    expect(handoffTarget(run({ role: 'review', status: 'finished' }))).toBeUndefined();
    expect(
      handoffTarget(run({ role: 'review', status: 'finished', verdict: 'mergeable' }))?.role,
    ).toBe('implement');
    expect(handoffTarget(run({ role: 'design', status: 'finished' }))?.role).toBe('implement');
  });

  it('opens a handoff form from Review on a finished implement run, pre-filled from the review profile', () => {
    const onLaunch = vi.fn();
    const implementer = run({
      id: 'impl-1' as AgentRunSummary['id'],
      status: 'finished',
      role: 'implement',
      backend: 'codex',
    });
    render(<DelegationPanel {...panelProps({ runs: [implementer], onLaunch })} />);
    const table = screen.getByRole('table', { name: 'Agent runs' });
    fireEvent.click(within(table).getByRole('button', { name: 'Review' }));
    const form = screen.getByRole('form', { name: 'Review with' });
    expect((within(form).getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude-code');
    fireEvent.click(within(form).getByRole('button', { name: 'Launch' }));
    expect(onLaunch).toHaveBeenCalledWith({
      backend: 'claude-code',
      worktreeId: 'wt-1',
      role: 'review',
      permissionMode: 'auto',
      model: 'opus',
      parentRunId: 'impl-1',
    });
  });

  it('offers the review handoff on the run page', () => {
    const onHandoff = vi.fn();
    render(
      <RunPage
        detail={
          {
            run: run({ status: 'finished', role: 'implement' }),
            worktree,
            brief: '# Work item AQ-01',
            eventCount: 1,
          } as AgentRunDetailResponse
        }
        events={[]}
        connection="open"
        backends={[claude, codex]}
        profiles={profiles}
        canMutate={true}
        busy={false}
        onSend={vi.fn()}
        onEnd={vi.fn()}
        onCancel={vi.fn()}
        onOpenWorkItem={vi.fn()}
        onLoadDiff={vi.fn()}
        onCloseDiff={vi.fn()}
        onHandoff={onHandoff}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review this implementation' }));
    const form = screen.getByRole('form', { name: 'Review with' });
    fireEvent.click(within(form).getByRole('button', { name: 'Launch' }));
    expect(onHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'review', parentRunId: 'run-1' }),
    );
  });
});
