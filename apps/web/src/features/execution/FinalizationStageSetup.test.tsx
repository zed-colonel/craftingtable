import type { EffectiveAgent } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { FinalizationRecoveryAgent } from '../../decisions/finalization/FinalizationRecoveryAgent.js';
import { defaultFinalizationStages, FinalizationStageSetup } from './FinalizationStageSetup.js';

afterEach(cleanup);

/** E5-3: a finalization stage's agents are per-action overrides over the workspace default. */
const backends = [
  {
    kind: 'claude-code' as const,
    label: 'Claude Code',
    available: true,
    models: [{ id: 'opus', label: 'Opus', section: 'main', hidden: false }],
    catalog: { source: 'catalog' as const },
  },
];
const review: EffectiveAgent = {
  selection: { backend: 'claude-code', model: 'opus' },
  source: { layer: 'workspace-default', slot: 'review' },
  permissionMode: 'edit-only',
};
const implement: EffectiveAgent = {
  selection: { backend: 'claude-code' },
  source: { layer: 'daemon-default' },
  permissionMode: 'auto',
};

function Setup() {
  const [stages, setStages] = useState(() =>
    defaultFinalizationStages(
      { ...review.selection, permissionMode: 'edit-only' },
      { ...implement.selection, permissionMode: 'auto' },
    ),
  );
  return (
    <FinalizationStageSetup
      defaults={{ review, implement }}
      stages={stages}
      onChange={setStages}
      backends={backends}
      disabled={false}
    />
  );
}

it('names the workspace default a stage inherits, and a change made for that stage alone', () => {
  render(<Setup />);
  const first = screen.getAllByText(/^Stage reviewer:/)[0]!;
  expect(first.textContent).toBe('Stage reviewer: Claude Code · opus · Workspace default');
  const stage = first.closest('.disclosure-body') as HTMLElement;
  fireEvent.click(within(stage).getAllByRole('button', { name: 'Change for this stage' })[0]!);
  const reviewer = within(stage).getAllByRole('group', { name: 'Stage reviewer' })[0]!;
  fireEvent.change(within(reviewer).getByLabelText('Reasoning effort'), {
    target: { value: 'high' },
  });
  expect(screen.getAllByText(/^Stage reviewer:/)[0]!.textContent).toBe(
    'Stage reviewer: Claude Code · opus · high effort · changed for this stage',
  );
  // Every other stage still inherits.
  expect(screen.getAllByText(/^Stage reviewer:/)[1]!.textContent).toContain('Workspace default');
  fireEvent.click(within(stage).getAllByRole('button', { name: 'Use the workspace default' })[0]!);
  expect(screen.getAllByText(/^Stage reviewer:/)[0]!.textContent).toContain('Workspace default');
});

it('says which agent a finalization step runs now and what it overrides', () => {
  render(
    <FinalizationRecoveryAgent
      mode="keep"
      onMode={vi.fn()}
      value={{ backend: 'claude-code' }}
      onChange={vi.fn()}
      current={{ backend: 'claude-code', model: 'opus' }}
      currentAgent={{
        selection: { backend: 'claude-code', model: 'opus' },
        source: { layer: 'finalization-recovery', slot: 'review', stageIndex: 1 },
        permissionMode: 'edit-only',
        inherited: {
          selection: { backend: 'claude-code', model: 'sonnet' },
          source: { layer: 'finalization-stage', slot: 'review', stageIndex: 1 },
        },
      }}
      backends={backends}
      disabled={false}
    />,
  );
  expect(screen.getByText(/^Runs now:/).textContent).toBe(
    'Runs now: Claude Code · opus · Finalization recovery agent 2 (over Claude Code · sonnet, finalization stage 2)',
  );
});

it('offers simplification and polish the optional-findings choice, absent unless follow-up (R-C7 D6)', () => {
  const onChange = vi.fn();
  const stages = defaultFinalizationStages(
    { ...review.selection, permissionMode: 'edit-only' },
    { ...implement.selection, permissionMode: 'auto' },
  );
  render(
    <FinalizationStageSetup
      stages={stages}
      onChange={onChange}
      backends={backends}
      disabled={false}
    />,
  );
  const choices = screen.getAllByLabelText('Optional findings') as HTMLSelectElement[];
  // Only the simplification and polish stages take it.
  expect(choices).toHaveLength(
    stages.filter((s) => s.kind === 'simplification' || s.kind === 'polish').length,
  );
  expect(choices[0]!.value).toBe('select');
  fireEvent.change(choices[0]!, { target: { value: 'follow-up' } });
  const changed = onChange.mock.calls[0]![0] as typeof stages;
  const index = stages.findIndex((s) => s.kind === 'simplification' || s.kind === 'polish');
  expect(changed[index]!.optionalFindings).toBe('follow-up');
  expect(changed.filter((s) => s.optionalFindings !== undefined)).toHaveLength(1);
});

it('counts a stage’s own permission change as a change for that stage (review W16)', () => {
  render(<Setup />);
  const first = screen.getAllByText(/^Stage reviewer:/)[0]!;
  const stage = first.closest('.disclosure-body') as HTMLElement;
  fireEvent.click(within(stage).getAllByRole('button', { name: 'Change for this stage' })[0]!);
  const reviewer = within(stage).getAllByRole('group', { name: 'Stage reviewer' })[0]!;
  fireEvent.change(within(reviewer).getByLabelText('Permissions'), { target: { value: 'auto' } });
  expect(screen.getAllByText(/^Stage reviewer:/)[0]!.textContent).toContain(
    'changed for this stage',
  );
});

// R-C17 part 4 (increment 1 review L-4): each new finalization stage starts from 120 minutes.
it('seeds every default stage with 120 minutes per step', () => {
  const profile = { backend: 'claude-code' as const, permissionMode: 'auto' as const };
  for (const stage of defaultFinalizationStages(profile, profile))
    expect(stage.policy.maxRunMinutes).toBe(120);
});
