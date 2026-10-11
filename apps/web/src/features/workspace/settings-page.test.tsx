import type {
  AgentRunProfileEntry,
  RunProfilesResponse,
  WorkspaceOverview,
} from '@craftingtable/contracts';
import {
  AGENT_PROFILE_PURPOSES,
  type AgentProfilePurpose,
  CYCLE_STEPS,
  PROFILE_INHERITANCE,
  type SpecialistProfile,
} from '@craftingtable/domain';
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
    models: [{ id: 'opus', label: 'Opus', section: 'main', hidden: false }],
    catalog: { source: 'catalog' as const },
  },
  {
    kind: 'codex' as const,
    label: 'Codex',
    available: true,
    models: [{ id: 'gpt-5', label: 'GPT-5', section: 'main', hidden: false }],
    catalog: { source: 'catalog' as const },
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

/**
 * The defaults as the daemon reports them (R-E5a): each purpose's saved profile, or the one it
 * inherits, or the daemon's; the selection set holds every step and each saved specialist.
 */
function defaultsOf(entries: readonly AgentRunProfileEntry[]): RunProfilesResponse {
  const stored = (role: AgentProfilePurpose) =>
    entries.find((entry) => entry.role === role && entry.stored);
  const chain = (role: AgentProfilePurpose): AgentProfilePurpose[] =>
    role === 'remediate'
      ? ['remediate', 'implement']
      : role in PROFILE_INHERITANCE
        ? [role, PROFILE_INHERITANCE[role as SpecialistProfile]]
        : [role];
  const agents = Object.fromEntries(
    AGENT_PROFILE_PURPOSES.map((purpose) => {
      const slot = chain(purpose).find((role) => stored(role));
      const profile = slot && stored(slot);
      return [
        purpose,
        profile && slot
          ? {
              selection: {
                backend: profile.backend,
                ...(profile.model ? { model: profile.model } : {}),
                ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
              },
              source: { layer: 'workspace-default', slot },
              permissionMode: profile.permissionMode,
            }
          : {
              selection: { backend: 'claude-code' },
              source: { layer: 'daemon-default' },
              permissionMode: 'auto',
            },
      ];
    }),
  ) as NonNullable<RunProfilesResponse['agents']>;
  return {
    profiles: [...entries],
    agents,
    selections: Object.fromEntries(
      AGENT_PROFILE_PURPOSES.flatMap((purpose) =>
        (CYCLE_STEPS as readonly string[]).includes(purpose) || stored(purpose)
          ? [[purpose, agents[purpose].selection]]
          : [],
      ),
    ) as NonNullable<RunProfilesResponse['selections']>,
  };
}

it('edits one profile per role and saves the whole set', () => {
  const onSaveProfiles = vi.fn();
  render(
    <SettingsPage
      workspace={workspace}
      canEdit={true}
      busy={false}
      onRename={vi.fn()}
      backends={backends}
      section="agents"
      defaults={defaultsOf(profiles)}
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
      section="agents"
      defaults={defaultsOf(profiles)}
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
      section="agents"
      defaults={defaultsOf(profiles)}
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

it('warns about a saved model that left the catalog, and still lets the profiles be edited (R-G15)', () => {
  const onSaveProfiles = vi.fn();
  render(
    <SettingsPage
      workspace={workspace}
      canEdit={true}
      busy={false}
      onRename={vi.fn()}
      backends={backends}
      section="agents"
      defaults={defaultsOf([
        ...profiles.slice(0, 2),
        { role: 'review', backend: 'codex', model: 'gpt-4', permissionMode: 'auto', stored: true },
      ])}
      onSaveProfiles={onSaveProfiles}
    />,
  );
  const section = screen.getByRole('region', { name: 'Agent profiles' });
  expect(within(section).getByRole('note').textContent).toContain(
    'gpt-4 is not in Codex’s model list; runs still send it',
  );
  fireEvent.click(within(section).getByRole('button', { name: 'Edit workspace defaults' }));
  fireEvent.click(within(section).getByRole('button', { name: 'Save workspace defaults' }));
  expect(onSaveProfiles).toHaveBeenCalledOnce();
});

it('shows each default’s source as the daemon reports it, and one section per page (R-E5b)', () => {
  render(
    <SettingsPage
      section="agents"
      workspace={workspace}
      canEdit
      busy={false}
      onRename={vi.fn()}
      backends={backends}
      defaults={defaultsOf(profiles)}
      onSaveProfiles={vi.fn()}
    />,
  );
  const table = within(screen.getByRole('region', { name: 'Agent profiles' })).getAllByRole(
    'table',
  )[0]!;
  const remediation = within(table).getByRole('row', { name: /^Remediation/ });
  expect(within(remediation).getByText('Daemon default')).toBeTruthy();
  const review = within(table).getByRole('row', { name: /^Review/ });
  expect(within(review).getByText('Workspace default')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Rename workspace' })).toBeNull();
  const tabs = screen.getByRole('navigation', { name: 'Settings pages' });
  expect(within(tabs).getByRole('link', { name: 'Agents' }).getAttribute('aria-current')).toBe(
    'page',
  );
  expect(within(tabs).getByRole('link', { name: 'Capacity' }).getAttribute('href')).toBe(
    '/workspaces/ws-1/settings/capacity',
  );
  // Notifications and storage are offered only to whoever can use them.
  expect(within(tabs).queryByRole('link', { name: 'Storage' })).toBeNull();
});
