import type { WorkspaceOverview } from '@craftingtable/contracts';
import type {
  RepositoryCleanupView,
  Roadmap,
  RoadmapWindDownView,
  WorkspaceId,
} from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionProvider, WorkspaceProvider } from '../../app/session.js';
import { request } from '../../lib/api-client.js';
import { createQueryStore, QueryStoreProvider } from '../../lib/query-store.js';
import { RoadmapWindDown } from './RoadmapWindDown.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(request).mockReset();
});

const ws = 'workspace-1' as WorkspaceId;
const roadmapId = '00000000-0000-4000-8000-000000000010';
const digest = 'a'.repeat(64);

function roadmap(status: Roadmap['status']): Roadmap {
  return { id: roadmapId, workspaceId: ws, status, version: 3 } as unknown as Roadmap;
}

const windDown = (fields: Partial<RoadmapWindDownView> = {}): RoadmapWindDownView =>
  ({
    preview: {
      roadmapId,
      status: 'running',
      digest,
      cycles: [
        {
          cycleId: 'cycle-1',
          label: 'WI-03',
          status: 'running',
          liveRunId: 'run-1',
          investigation: false,
          abandonsResolution: true,
          reservedMerge: false,
        },
      ],
      preparations: [],
      attention: [],
      versions: [
        {
          planVersionId: 'version-wi',
          projectId: 'project-wi',
          projectName: 'WorldInterface',
          versionNumber: 2,
          active: true,
          admittedItems: 9,
          activeWorktrees: 12,
        },
        {
          planVersionId: 'version-exo',
          projectId: 'project-exo',
          projectName: 'Exoskeleton',
          versionNumber: 2,
          active: true,
          admittedItems: 4,
          activeWorktrees: 11,
          refusal: {
            code: 'version-in-use',
            message: 'The roadmap Other still runs this version.',
          },
        },
      ],
      refusals: [],
    },
    ...fields,
  }) as RoadmapWindDownView;

function show(view: Roadmap, { isOwner = true } = {}) {
  const store = createQueryStore({ debounceMs: 0, maxWaitMs: 0 });
  return render(
    <QueryStoreProvider value={store}>
      <SessionProvider
        value={{ user: { username: 'operator' } as never, csrfToken: 'csrf', expire: vi.fn() }}
      >
        <WorkspaceProvider
          value={{
            workspaceId: ws,
            workspace: {
              id: ws,
              name: 'W',
              role: isOwner ? 'owner' : 'editor',
            } as WorkspaceOverview,
            canMutate: true,
            isOwner,
          }}
        >
          <RoadmapWindDown
            roadmap={view}
            workspaceId={ws}
            csrfToken="csrf"
            canMutate
            isOwner={isOwner}
            onChanged={vi.fn()}
          />
        </WorkspaceProvider>
      </SessionProvider>
    </QueryStoreProvider>,
  );
}

const posted = () =>
  vi
    .mocked(request)
    .mock.calls.filter(([, , init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, , init]) => ({ url, body: JSON.parse(String((init as RequestInit).body)) }));

it('stops with nothing retired, or winds down the chosen versions, posting the digest it showed (R-B11)', async () => {
  vi.mocked(request).mockImplementation(async (url) =>
    String(url).endsWith('/wind-down') ? windDown() : ({} as never),
  );
  show(roadmap('running'));
  fireEvent.click(screen.getByRole('button', { name: 'Stop or wind down…' }));
  const form = within(await screen.findByRole('region', { name: 'Stop or wind down' }));
  // What stops, named: the resolution the preview says is abandoned.
  expect(form.getByRole('list', { name: 'What stops' }).textContent).toContain(
    'its integration resolution is abandoned',
  );
  // A version another roadmap runs cannot be retired; its refusal is shown, not a choice.
  expect(form.getByText('The roadmap Other still runs this version.')).toBeTruthy();
  expect(form.queryByRole('radiogroup', { name: 'Version 2 of Exoskeleton' })).toBeNull();
  fireEvent.click(form.getByRole('button', { name: 'Stop roadmap' }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]).toEqual({
    url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/wind-down`,
    body: { expectedDigest: digest, retire: [] },
  });
  // Choosing a retirement turns Stop into Wind down.
  const choices = form.getByRole('radiogroup', { name: 'Version 2 of WorldInterface' });
  fireEvent.click(within(choices).getByRole('radio', { name: 'Retire, superseded' }));
  fireEvent.click(form.getByRole('button', { name: 'Wind down' }));
  await waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted()[1]?.body).toEqual({
    expectedDigest: digest,
    retire: [{ planVersionId: 'version-wi', disposition: 'superseded' }],
  });
});

it('refuses by the daemon’s code before anything is sent, and shows a settling record’s progress', async () => {
  vi.mocked(request).mockImplementation(async () =>
    windDown({
      record: {
        status: 'settling',
        incomplete: { step: 'cycles', at: '2026-10-13T00:00:00.000Z', message: 'WI-03 is busy.' },
      } as RoadmapWindDownView['record'],
      preview: {
        ...windDown().preview,
        refusals: [{ code: 'merge-in-flight', message: 'A merge is reserved on one worktree.' }],
      },
    }),
  );
  show(roadmap('running'));
  fireEvent.click(screen.getByRole('button', { name: 'Stop or wind down…' }));
  const form = within(await screen.findByRole('region', { name: 'Stop or wind down' }));
  expect(form.getByText('A merge is reserved on one worktree.')).toBeTruthy();
  expect(form.getByText('WI-03 is busy.')).toBeTruthy();
  expect(form.getByRole('button', { name: 'Stop roadmap' })).toHaveProperty('disabled', true);
});

it('offers an owner the cleanup of a wound-down roadmap, and an editor only its plan', async () => {
  const cleanupView: RepositoryCleanupView = {
    preview: {
      roadmapId,
      digest,
      refusals: [],
      actions: [
        {
          kind: 'delete-branch',
          repositoryId: 'repo-1',
          branchName: 'ct/wi-03',
          tipSha: 'b'.repeat(40),
          keeper: { kind: 'parked-tag', tag: 'worldinterface/parked/wi-03' },
          state: 'planned',
        },
        {
          kind: 'remove-worktree',
          worktreeId: 'tree-1',
          repositoryId: 'repo-1',
          branchName: 'ct/wi-05',
          state: 'kept',
          code: 'dirty',
          note: 'It has uncommitted or untracked changes.',
        },
      ],
    },
  } as unknown as RepositoryCleanupView;
  vi.mocked(request).mockImplementation(async (url) =>
    String(url).endsWith('/cleanup')
      ? cleanupView
      : windDown({
          record: { status: 'settled', retire: [] } as unknown as RoadmapWindDownView['record'],
        }),
  );
  const { unmount } = show(roadmap('stopped'), { isOwner: false });
  fireEvent.click(await screen.findByRole('button', { name: 'Clean up repositories…' }));
  let form = within(await screen.findByRole('region', { name: 'Clean up repositories' }));
  expect(await form.findByText(/worldinterface\/parked\/wi-03/)).toBeTruthy();
  expect(form.getByRole('button', { name: 'Clean up repositories' })).toHaveProperty(
    'disabled',
    true,
  );
  unmount();
  show(roadmap('stopped'));
  fireEvent.click(await screen.findByRole('button', { name: 'Clean up repositories…' }));
  form = within(await screen.findByRole('region', { name: 'Clean up repositories' }));
  await form.findByText(/worldinterface\/parked\/wi-03/);
  fireEvent.click(form.getByRole('checkbox', { name: /Discard uncommitted changes/ }));
  fireEvent.click(form.getByRole('button', { name: 'Clean up repositories' }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]).toEqual({
    url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/cleanup`,
    body: { expectedDigest: digest, discardDirty: true },
  });
});
