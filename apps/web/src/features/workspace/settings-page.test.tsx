import type { AgentRunProfileEntry, WorkspaceOverview } from '@craftingtable/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage.js';

afterEach(cleanup);

const workspace = {
  id: 'ws-1',
  name: 'Home',
  slug: 'home',
  status: 'active',
  role: 'owner',
  projectCount: 1,
} as WorkspaceOverview;

const backends = [
  {
    kind: 'claude-code' as const,
    label: 'Claude Code',
    available: true,
    models: [{ id: 'opus', label: 'Opus' }],
  },
  {
    kind: 'codex' as const,
    label: 'Codex',
    available: true,
    models: [{ id: 'gpt-5', label: 'GPT-5' }],
  },
];

const profiles: readonly AgentRunProfileEntry[] = [
  { role: 'design', backend: 'claude-code', permissionMode: 'auto', stored: false },
  { role: 'implement', backend: 'claude-code', permissionMode: 'auto', stored: false },
  {
    role: 'review',
    backend: 'claude-code',
    model: 'opus',
    permissionMode: 'edit-only',
    stored: true,
  },
];

it('edits one profile per role and saves the whole set', () => {
  const onSaveProfiles = vi.fn();
  render(
    <SettingsPage
      workspace={workspace}
      canEdit={true}
      busy={false}
      onRename={vi.fn()}
      backends={backends}
      profiles={profiles}
      onSaveProfiles={onSaveProfiles}
    />,
  );
  const section = screen.getByRole('region', { name: 'Agent profiles' });
  fireEvent.click(within(section).getByRole('button', { name: 'Edit workspace defaults' }));
  const implement = within(section).getByRole('group', { name: 'Implementation' });
  fireEvent.change(within(implement).getByLabelText('Agent'), { target: { value: 'codex' } });
  fireEvent.change(within(implement).getByLabelText('Model'), { target: { value: 'gpt-5' } });
  fireEvent.change(within(section).getByLabelText('Implementation permissions'), {
    target: { value: 'unrestricted' },
  });
  fireEvent.click(within(section).getByRole('button', { name: 'Save workspace defaults' }));
  expect(onSaveProfiles).toHaveBeenCalledWith([
    { role: 'design', backend: 'claude-code', permissionMode: 'auto' },
    { role: 'implement', backend: 'codex', model: 'gpt-5', permissionMode: 'unrestricted' },
    { role: 'review', backend: 'claude-code', model: 'opus', permissionMode: 'edit-only' },
    { role: 'remediate', backend: 'claude-code', permissionMode: 'auto' },
  ]);
});

it('provides separate remediation and specialist inheritance with a map of recommended fields', () => {
  const save = vi.fn();
  render(
    <SettingsPage
      workspace={workspace}
      canEdit
      busy={false}
      onRename={vi.fn()}
      backends={backends}
      profiles={profiles}
      onSaveProfiles={save}
    />,
  );
  fireEvent.click(screen.getByText('Suggested models and where to set them'));
  expect(screen.getAllByRole('cell', { name: 'GPT-6 Sol · High' }).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Edit workspace defaults' }));
  fireEvent.click(screen.getByText(/Specialist overrides ·/));
  const security = screen.getByRole('group', { name: 'Security review' });
  expect(within(security).getByText(/Inherits Review/)).toBeTruthy();
  fireEvent.click(within(security).getByRole('checkbox'));
  fireEvent.change(within(security).getByLabelText('Agent'), { target: { value: 'codex' } });
  fireEvent.change(within(security).getByLabelText('Reasoning effort'), {
    target: { value: 'high' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save workspace defaults' }));
  const saved = save.mock.calls[0]![0];
  expect(saved.find((p: { role: string }) => p.role === 'security')).toMatchObject({
    backend: 'codex',
    reasoningEffort: 'high',
    permissionMode: 'edit-only',
  });
  expect(saved.find((p: { role: string }) => p.role === 'remediate')).toBeDefined();
});

it("offers a reasoning effort for Claude profiles too, defaulting to Claude Code's own (operator decision 2026-09-28)", () => {
  const save = vi.fn();
  render(
    <SettingsPage
      workspace={workspace}
      canEdit
      busy={false}
      onRename={vi.fn()}
      backends={backends}
      profiles={profiles}
      onSaveProfiles={save}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit workspace defaults' }));
  const review = screen.getByRole('group', { name: 'Review' });
  const effort = within(review).getByLabelText<HTMLSelectElement>('Reasoning effort');
  expect(effort.selectedOptions[0]?.textContent).toBe("Use Claude Code's default");
  fireEvent.change(effort, { target: { value: 'xhigh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save workspace defaults' }));
  expect(save.mock.calls[0]![0].find((p: { role: string }) => p.role === 'review')).toMatchObject({
    backend: 'claude-code',
    reasoningEffort: 'xhigh',
  });
});
