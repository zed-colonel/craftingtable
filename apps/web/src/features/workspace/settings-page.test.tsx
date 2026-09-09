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
  const implement = within(section).getByRole('group', { name: 'Implement' });
  fireEvent.change(within(implement).getByLabelText('Agent'), { target: { value: 'codex' } });
  fireEvent.change(within(implement).getByLabelText('Model'), { target: { value: 'gpt-5' } });
  fireEvent.change(within(implement).getByLabelText('Permissions'), {
    target: { value: 'unrestricted' },
  });
  fireEvent.click(within(section).getByRole('button', { name: 'Save profiles' }));
  expect(onSaveProfiles).toHaveBeenCalledWith([
    { role: 'design', backend: 'claude-code', permissionMode: 'auto' },
    { role: 'implement', backend: 'codex', model: 'gpt-5', permissionMode: 'unrestricted' },
    { role: 'review', backend: 'claude-code', model: 'opus', permissionMode: 'edit-only' },
  ]);
});
