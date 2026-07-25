import type {
  AuthenticatedSessionResponse,
  WorkspaceAuditPageResponse,
  WorkspaceListResponse,
  WorkspaceSnapshotResponse,
} from '@craftingtable/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CT03-RR4 regression cover.
 *
 * The re-review found that switching workspaces committed a render with the new
 * workspace selected and the *previous* workspace's projection, because the
 * clearing ran in a post-render effect. This drives the real selection path and
 * holds the second workspace's requests pending, so any leaked content from the
 * first workspace is visible to the assertions.
 */

const EMPTY_RISK_COUNTS = { low: 0, medium: 0, high: 0, critical: 0, unspecified: 0 };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SESSION = {
  user: { id: 'user-1', username: 'keith', status: 'active' },
  session: {
    id: 'session-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    lastSeenAt: '2026-07-24T00:00:00.000Z',
    expiresAt: '2026-08-24T00:00:00.000Z',
    status: 'active',
    current: true,
  },
  csrfToken: 'csrf-token-value',
} as unknown as AuthenticatedSessionResponse;

const WORKSPACES = {
  workspaces: [
    {
      id: 'workspace-a',
      name: 'Workspace A',
      slug: 'workspace-a',
      status: 'active',
      role: 'owner',
    },
    {
      id: 'workspace-b',
      name: 'Workspace B',
      slug: 'workspace-b',
      status: 'active',
      role: 'owner',
    },
  ],
} as unknown as WorkspaceListResponse;

function snapshotFor(id: string, projectName: string, eventName: string) {
  return {
    workspace: {
      id,
      name: id === 'workspace-a' ? 'Workspace A' : 'Workspace B',
      slug: id,
      status: 'active',
      role: 'owner',
    },
    asOfSequence: id === 'workspace-a' ? 5 : 9,
    statusSummary: {
      needsAttention: 0,
      active: 0,
      planningReady: id === 'workspace-a' ? 7 : 3,
      dependencyBlocked: 0,
    },
    planningSummary: {
      projectCount: 1,
      importAttentionCount: 0,
      proposedCount: 0,
      admittedCount: 0,
      planningReadyCount: 0,
      dependencyBlockedCount: 0,
      riskCounts: EMPTY_RISK_COUNTS,
    },
    projects: [
      {
        id: `project-${id}`,
        name: projectName,
        slug: 'p',
        versionCount: 1,
        warningCount: 0,
        createdAt: '2026-07-24T00:00:00.000Z',
        proposedCount: 0,
        admittedCount: 0,
        planningReadyCount: 0,
        dependencyBlockedCount: 0,
        riskCounts: EMPTY_RISK_COUNTS,
      },
    ],
    recentActivity: [
      {
        id: `event-${id}`,
        sequence: id === 'workspace-a' ? 5 : 9,
        occurredAt: '2026-07-24T00:00:00.000Z',
        workspaceId: id,
        schemaVersion: 1,
        kind: 'project-created',
        payload: { projectId: `project-${id}`, name: eventName },
      },
    ],
  } as unknown as WorkspaceSnapshotResponse;
}

const SNAPSHOT_A = snapshotFor('workspace-a', 'Alpha Project', 'Alpha Activity');
const SNAPSHOT_B = snapshotFor('workspace-b', 'Beta Project', 'Beta Activity');

const AUDIT_A = {
  records: [
    {
      sequence: 1,
      id: 'audit-a',
      occurredAt: '2026-07-24T00:00:00.000Z',
      actorKind: 'user',
      action: 'plan.import.succeeded',
      outcome: 'succeeded',
    },
  ],
} as unknown as WorkspaceAuditPageResponse;

function projectDetailFor(workspaceId: string) {
  const label = workspaceId === 'workspace-a' ? 'Alpha' : 'Beta';
  return {
    project: {
      id: `project-${workspaceId}`,
      name: `${label} Project`,
      slug: 'p',
      activePlanVersionId: `version-${workspaceId}`,
      document: `${label} Plan`,
      versionCount: 1,
      warningCount: 0,
      createdAt: '2026-07-24T00:00:00.000Z',
      proposedCount: 1,
      admittedCount: 0,
      planningReadyCount: 1,
      dependencyBlockedCount: 0,
      riskCounts: EMPTY_RISK_COUNTS,
    },
    versions: [],
    activeVersion: {
      version: {
        id: `version-${workspaceId}`,
        versionNumber: 1,
        contentDigest: 'd'.repeat(64),
        document: `${label} Plan`,
        itemCount: 1,
        requiredDependencyCount: 0,
        createdAt: '2026-07-24T00:00:00.000Z',
        isActive: true,
        sourceProfile: 'exo-work-breakdown-v1',
        digestAlgorithm: 'sha-256',
        digestFormatVersion: 1,
      },
      projectId: `project-${workspaceId}`,
      counts: {
        proposedCount: 1,
        admittedCount: 0,
        planningReadyCount: 1,
        dependencyBlockedCount: 0,
        riskCounts: EMPTY_RISK_COUNTS,
      },
      artifacts: [
        {
          id: `artifact-${workspaceId}`,
          logicalFilename: `${label.toLowerCase()}-source.yaml`,
          role: 'work-breakdown',
          mediaType: 'application/yaml',
          byteLength: 10,
          sha256: 'a'.repeat(64),
        },
      ],
      diagnostics: [],
      workItems: [],
    },
  } as never;
}

function workItemDetailFor(workspaceId: string) {
  const label = workspaceId === 'workspace-a' ? 'Alpha' : 'Beta';
  return {
    workItem: {
      id: `item-${workspaceId}`,
      sourceId: label === 'Alpha' ? 'AQ-01' : 'BQ-01',
      ordinal: 0,
      title: `${label} work item`,
      status: 'proposed',
      risk: 'medium',
      primaryAreas: [],
      exitGate: 'Green.',
      requiredPredecessorCount: 0,
      recommendedPredecessorCount: 0,
      blockerSourceIds: [],
      readiness: 'planning-ready',
      projectId: `project-${workspaceId}`,
      planVersionId: `version-${workspaceId}`,
    },
    projectName: `${label} Project`,
    requiredPredecessors: [],
    recommendedPredecessors: [],
    dependents: [],
    draft: null,
  } as never;
}

const snapshotCalls: string[] = [];
let pendingSnapshotB: Deferred<WorkspaceSnapshotResponse>;

vi.mock('./lib/api-client.js', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  loadSession: () => Promise.resolve(SESSION),
  loadSessions: () => Promise.resolve({ sessions: [] }),
  loadWorkspaces: () => Promise.resolve(WORKSPACES),
  loadWorkspaceSnapshot: (id: string) => {
    snapshotCalls.push(id);
    return id === 'workspace-a' ? Promise.resolve(SNAPSHOT_A) : pendingSnapshotB.promise;
  },
  loadWorkspaceAudit: (id: string) =>
    Promise.resolve(id === 'workspace-a' ? AUDIT_A : { records: [] }),
  login: () => Promise.resolve(SESSION),
  logout: () => Promise.resolve(),
  revokeSession: () => Promise.resolve(false),
  request: () => Promise.reject(new Error('not used')),
}));

// The event stream is irrelevant to this transition; keep it inert.
vi.mock('./lib/use-workspace-event-stream.js', () => ({
  useWorkspaceEventStream: () => undefined,
}));

/** Deferreds for the requests whose results must never cross workspaces. */
const planning = {
  artifact: deferred<string>(),
  admit: deferred<unknown>(),
  import: deferred<unknown>(),
};

vi.mock('./lib/planning-api.js', () => ({
  loadProjects: () => new Promise(() => undefined),
  loadProject: (workspaceId: string) => Promise.resolve(projectDetailFor(workspaceId)),
  loadPlanVersion: () => new Promise(() => undefined),
  loadWorkItem: (workspaceId: string) => Promise.resolve(workItemDetailFor(workspaceId)),
  loadImportAttempts: () => new Promise(() => undefined),
  loadArtifactText: () => planning.artifact.promise,
  admitWorkItem: () => planning.admit.promise,
  importPlanBundle: () => planning.import.promise,
}));

const { App } = await import('./App.js');

interface RenderSample {
  readonly turn: number;
  readonly pathname: string;
  readonly text: string;
}

function renderApp() {
  return render(<App />);
}

/**
 * Samples the URL and the committed DOM once per microtask turn.
 *
 * `waitFor` and `act` both only ever expose the *settled* state, so neither can
 * see a workspace switch that renders correctly only once a passive effect has
 * caught up. React commits a state update within one microtask turn but
 * schedules passive effects on a later macrotask, so sampling per turn is what
 * distinguishes "correct by construction" from "corrected by an effect"
 * (CT03-R2R4).
 *
 * Turn 0 is recorded but never asserted on: it is read before React has been
 * given any turn in which to respond, so every implementation looks identical
 * there.
 */
async function sampleMicrotaskTurns(turns: number): Promise<RenderSample[]> {
  const samples: RenderSample[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    samples.push({
      turn,
      pathname: window.location.pathname,
      text: document.body.textContent ?? '',
    });
    await Promise.resolve();
  }
  return samples;
}

/**
 * Lets every pending promise callback, state update, and passive effect run.
 *
 * Asserting absence through `waitFor` is worthless: its first check succeeds
 * immediately, before the leaked update has even been committed. Absence must
 * be asserted only after the work that would produce the leak has fully run.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  snapshotCalls.length = 0;
  pendingSnapshotB = deferred<WorkspaceSnapshotResponse>();
  planning.artifact = deferred<string>();
  planning.admit = deferred<unknown>();
  planning.import = deferred<unknown>();
  window.history.replaceState(null, '', '/');
});

afterEach(cleanup);

describe('workspace switching in the app (CT03-RR4)', () => {
  it('never renders the previous workspace projection under the new selection', async () => {
    renderApp();

    // Workspace A is fully loaded and visible.
    await screen.findByText('Alpha Project');
    expect(screen.getByText('Project created: Alpha Activity')).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();

    // Select workspace B and hold its snapshot pending.
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'workspace-b' },
    });

    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));

    // With B selected and its data still in flight, nothing from A may render.
    expect(screen.queryByText('Alpha Project')).toBeNull();
    expect(screen.queryByText('Project created: Alpha Activity')).toBeNull();
    expect(screen.queryByText('7')).toBeNull();
    expect(screen.getByText('Loading durable workspace snapshot…')).toBeDefined();

    // Once B resolves, only B's content appears.
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');
    expect(screen.getByText('Project created: Beta Activity')).toBeDefined();
    expect(screen.queryByText('Alpha Project')).toBeNull();
    expect(screen.queryByText('Project created: Alpha Activity')).toBeNull();
  });

  it('keeps the previous workspace hidden when the new snapshot fails', async () => {
    renderApp();
    await screen.findByText('Alpha Project');

    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'workspace-b' },
    });
    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));

    pendingSnapshotB.reject(new Error('snapshot unavailable'));

    // A failed switch must degrade visibly, never fall back to workspace A.
    await screen.findByText('The workspace snapshot could not be loaded.');
    expect(screen.queryByText('Alpha Project')).toBeNull();
    expect(screen.queryByText('Project created: Alpha Activity')).toBeNull();
  });

  it('clears the audit panel belonging to the previous workspace', async () => {
    renderApp();
    await screen.findByText('Alpha Project');
    expect(screen.getByText('plan.import.succeeded')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'workspace-b' },
    });
    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));
    expect(screen.queryByText('plan.import.succeeded')).toBeNull();

    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');
    expect(screen.queryByText('plan.import.succeeded')).toBeNull();
  });
});

/**
 * CT03-R2R3 and CT03-R2R4.
 *
 * The previous remediation cleared state in the selection transition, but
 * requests already in flight still wrote their results afterwards, and a
 * route-driven change still went through a post-render effect.
 */
describe('in-flight results across a workspace change (CT03-R2R3)', () => {
  async function loadWorkspaceA(): Promise<void> {
    renderApp();
    await screen.findByText('Alpha Project');
  }

  function switchToB(): void {
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'workspace-b' },
    });
  }

  it('discards an artifact fetched for the previous workspace', async () => {
    await loadWorkspaceA();

    // Open workspace A's project and request one of its source artifacts.
    fireEvent.click(screen.getByRole('button', { name: 'Alpha Project' }));
    await screen.findByRole('heading', { name: 'Alpha Project' });
    fireEvent.click(screen.getByRole('button', { name: 'alpha-source.yaml' }));

    switchToB();
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');

    // Workspace A's artifact resolves only now. It must not appear under B.
    planning.artifact.resolve('document: Alpha secret\n');
    await settle();
    expect(screen.queryByText(/Alpha secret/)).toBeNull();
    expect(screen.queryByTestId('source-text')).toBeNull();
    expect(screen.queryByText('alpha-source.yaml')).toBeNull();
  });

  it('discards an admission error raised for the previous workspace', async () => {
    await loadWorkspaceA();

    window.history.pushState(null, '', '/workspaces/workspace-a/work-items/item-workspace-a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: /AQ-01 · Alpha work item/ });

    fireEvent.click(screen.getByRole('button', { name: 'Admit into agenda' }));
    expect(screen.getByRole('button', { name: 'Admitting…' })).toBeDefined();

    switchToB();
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');

    // Stand on workspace B's own work-item page, where a leaked error from A
    // would actually be rendered.
    window.history.pushState(null, '', '/workspaces/workspace-b/work-items/item-workspace-b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: /BQ-01 · Beta work item/ });

    planning.admit.reject(new Error('admission failed in workspace A'));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    // A plain Error renders as the generic message, so assert on what is shown.
    expect(screen.queryByText('Admission failed')).toBeNull();
    // The busy state was reset by the switch, not left stuck from A.
    expect(screen.queryByRole('button', { name: 'Admitting…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Admit into agenda' })).toBeDefined();
  });

  it('discards an import outcome produced for the previous workspace', async () => {
    await loadWorkspaceA();

    window.history.pushState(null, '', '/workspaces/workspace-a/import');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'Import a plan bundle' });

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Alpha import' },
    });
    for (const [label, name] of [
      ['Implementation plan (required)', 'plan.md'],
      ['Work breakdown (required)', 'breakdown.yaml'],
    ] as const) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['x'], name, { type: 'text/plain' })],
      });
      fireEvent.change(input);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Import plan bundle' }));
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDefined();

    switchToB();
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');

    // Stand on workspace B's import page, where a leaked outcome would render.
    window.history.pushState(null, '', '/workspaces/workspace-b/import');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'Import a plan bundle' });

    planning.import.resolve({
      importAttemptId: 'attempt-a',
      outcome: 'failed-validation',
      diagnostics: [
        { severity: 'error', code: 'invalid-yaml', message: 'Alpha import diagnostic' },
      ],
    });
    await settle();
    expect(screen.queryByRole('region', { name: 'Import result' })).toBeNull();
    expect(screen.queryByText(/Alpha import diagnostic/)).toBeNull();
    expect(screen.queryByText('Import failed validation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Importing…' })).toBeNull();
    // A failed import never navigates, but a leaked success would; the import
    // page for B must still be the one on screen.
    expect(window.location.pathname).toBe('/workspaces/workspace-b/import');
  });
});

describe('route-driven workspace changes (CT03-R2R4)', () => {
  it('never renders the previous workspace under a deep-linked new one', async () => {
    renderApp();
    await screen.findByText('Alpha Project');

    // A popstate straight into workspace B, whose snapshot stays pending.
    window.history.pushState(null, '', '/workspaces/workspace-b');
    window.dispatchEvent(new PopStateEvent('popstate'));

    const samples = await sampleMicrotaskTurns(16);

    // From the first turn in which React could respond onwards, no committed
    // DOM under workspace B's URL may still contain workspace A's content.
    // Deriving the identity from the route satisfies this on turn 1; relying on
    // an effect to correct it afterwards does not.
    const underB = samples.filter(
      (sample) => sample.turn > 0 && sample.pathname === '/workspaces/workspace-b',
    );
    expect(underB.length).toBeGreaterThan(0);
    for (const sample of underB) {
      expect(sample.text, `turn ${sample.turn}`).not.toContain('Alpha Project');
      expect(sample.text, `turn ${sample.turn}`).not.toContain('Alpha Activity');
      expect(sample.text, `turn ${sample.turn}`).not.toContain('plan.import.succeeded');
    }

    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));
    expect(screen.queryByText('Alpha Project')).toBeNull();
    expect(screen.getByText('Loading durable workspace snapshot…')).toBeDefined();

    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');
    expect(screen.queryByText('Alpha Project')).toBeNull();
  });

  it('shows the routed workspace as selected while its data loads', async () => {
    renderApp();
    await screen.findByText('Alpha Project');

    window.history.pushState(null, '', '/workspaces/workspace-b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));

    // The picker must agree with the URL immediately, not one render later.
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('workspace-b');
  });

  it('ignores a route naming a workspace the user cannot see', async () => {
    renderApp();
    await screen.findByText('Alpha Project');

    window.history.pushState(null, '', '/workspaces/workspace-unknown');
    window.dispatchEvent(new PopStateEvent('popstate'));

    // Falls back to the current selection rather than loading forever.
    await waitFor(() =>
      expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('workspace-a'),
    );
    expect(snapshotCalls).not.toContain('workspace-unknown');
  });
});
