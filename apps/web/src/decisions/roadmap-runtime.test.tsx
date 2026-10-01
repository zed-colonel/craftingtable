import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import { asWorkspaceId, type Roadmap } from '@craftingtable/domain';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../lib/api-client.js';
import { loadRoadmaps } from '../lib/roadmap-api.js';
import { RoadmapAmendments, RoadmapRuntime, runtimeScope } from './roadmap-runtime.js';

vi.mock('../lib/api-client.js', () => ({ request: vi.fn() }));
vi.mock('../lib/roadmap-api.js', () => ({ loadRoadmaps: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const scope = (definitionId: string, bindingRevision = 1) => ({
  executionScope: { definitionId, bindingRevision },
});
const roadmap = (definition: Partial<Roadmap['definition']>) =>
  ({
    id: 'r',
    workspaceId: 'ws',
    version: 3,
    definition: { revision: 2, entries: [], ...definition },
  }) as unknown as Roadmap;
const crossProject = roadmap({
  crossProject: { definitionId: 'map-x', bindingRevision: 4 } as never,
  entries: [scope('other') as never],
});

it("finds a roadmap's dependency environment: its cross-project map, or its slices' one map (LIVE-18)", () => {
  expect(runtimeScope(crossProject)).toEqual({ definitionId: 'map-x', bindingRevision: 4 });
  expect(runtimeScope(roadmap({ entries: [scope('m'), {}, scope('m')] as never }))).toEqual({
    definitionId: 'm',
    bindingRevision: 1,
  });
  // Two map revisions, or none: no single environment.
  expect(runtimeScope(roadmap({ entries: [scope('m'), scope('m', 2)] as never }))).toBeUndefined();
  expect(runtimeScope(roadmap({ entries: [{}] as never }))).toBeUndefined();
});

it("loads a setup decision's own environment view and takes a saved decision's view (R-A6 2b)", async () => {
  vi.mocked(loadRoadmaps).mockResolvedValue({
    roadmaps: [{ roadmap: crossProject }],
  } as never);
  vi.mocked(request).mockResolvedValue({ bindingRevision: 4, issues: ['first'] });
  let save: ((view: RuntimeEvidenceView) => void) | undefined;
  render(
    <RoadmapRuntime workspaceId={asWorkspaceId('ws')} roadmapId="r">
      {({ base, view, onSaved }) => {
        save = onSaved;
        return (
          <p>
            {base} · {view.issues.join()}
          </p>
        );
      }}
    </RoadmapRuntime>,
  );
  expect(
    await screen.findByText('/api/workspaces/ws/concurrency-definitions/map-x/runtime · first'),
  ).toBeTruthy();
  expect(vi.mocked(request).mock.calls[0]![0]).toBe(
    '/api/workspaces/ws/concurrency-definitions/map-x/runtime',
  );
  act(() => save!({ bindingRevision: 4, issues: ['saved'] } as unknown as RuntimeEvidenceView));
  expect(
    screen.getByText('/api/workspaces/ws/concurrency-definitions/map-x/runtime · saved'),
  ).toBeTruthy();
  expect(screen.getByRole('link', { name: "Open the roadmap's setup" })).toBeTruthy();
});

it('says why there is nothing to decide when the roadmap has no single map, or is gone', async () => {
  vi.mocked(loadRoadmaps).mockResolvedValue({
    roadmaps: [{ roadmap: roadmap({ entries: [scope('a'), scope('b')] as never }) }],
  } as never);
  const children = vi.fn(() => <p>decision</p>);
  const { unmount } = render(
    <RoadmapRuntime workspaceId={asWorkspaceId('ws')} roadmapId="r">
      {children}
    </RoadmapRuntime>,
  );
  expect(await screen.findByText(/has no single map/)).toBeTruthy();
  // The setup is still linked, where the roadmap's environments are set by hand.
  expect(screen.getByRole('link', { name: "Open the roadmap's setup" })).toBeTruthy();
  expect(children).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  unmount();

  vi.mocked(loadRoadmaps).mockResolvedValue({ roadmaps: [] } as never);
  render(
    <RoadmapAmendments workspaceId={asWorkspaceId('ws')} roadmapId="r">
      {children}
    </RoadmapAmendments>,
  );
  expect(await screen.findByText('This roadmap no longer exists.')).toBeTruthy();
});

it('hands a cross-project roadmap to its amendments, and only one (R-A6 2b)', async () => {
  vi.mocked(loadRoadmaps).mockResolvedValue({
    roadmaps: [{ roadmap: crossProject }],
  } as never);
  render(
    <RoadmapAmendments workspaceId={asWorkspaceId('ws')} roadmapId="r">
      {(r) => <p>amend {r.id}</p>}
    </RoadmapAmendments>,
  );
  expect(await screen.findByText('amend r')).toBeTruthy();
  cleanup();
  vi.mocked(loadRoadmaps).mockResolvedValue({
    roadmaps: [{ roadmap: roadmap({ entries: [scope('m')] as never }) }],
  } as never);
  render(
    <RoadmapAmendments workspaceId={asWorkspaceId('ws')} roadmapId="r">
      {(r) => <p>amend {r.id}</p>}
    </RoadmapAmendments>,
  );
  expect(await screen.findByText(/Only a cross-project roadmap/)).toBeTruthy();
});
