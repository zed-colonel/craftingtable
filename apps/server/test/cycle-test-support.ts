import type {
  AgentBackend,
  AgentLaunchRequest,
  AgentSession,
  AgentSessionItem,
} from '@craftingtable/agents';
import {
  createWorktreeResponseSchema,
  registerSourceRepositoryResponseSchema,
} from '@craftingtable/contracts';
import {
  type AgentRun,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  type ProviderFailure,
  type WorkCycle,
  type WorktreeId,
} from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import type { ServiceSet } from '../src/composition.js';
import {
  contexts,
  fixtureRepository,
  markFreeRunning,
  mutationHeaders,
  type ScriptedReply,
  type SignedIn,
  signIn,
} from './execution-test-support.js';
import { createTestContext } from './test-support.js';

/**
 * Cycle-controller tests whose agent turns finish only when the test says so, on the one
 * fixture stack (TS-M14): a stepped daemon registered with `contexts` (each test file runs
 * `afterEach(cleanupExecutionFixtures)`), one repository, and two work items admitted in
 * order. Tests step it with `stepDaemon` or `stepDaemons`, so nothing depends on wall-clock
 * time (R-B2), and release turns with the shared replies (`designDone`, `reviewText`).
 */

/**
 * A session whose turn completes only when the test releases it, like a long agent turn.
 * It reports a vendor session id unless told not to, and exits by signal when killed.
 */
export class HeldSession implements AgentSession {
  readonly pid = 5151;
  readonly backgroundWorkPending = false;
  private readonly queue: AgentSessionItem[] = [];
  private waiter: ((item: IteratorResult<AgentSessionItem>) => void) | undefined;
  private closed = false;

  constructor(
    readonly request: AgentLaunchRequest,
    sessionId: string | undefined,
  ) {
    if (sessionId !== undefined)
      this.push({
        type: 'event',
        event: {
          kind: 'session-started',
          payload: {
            backend: 'claude-code',
            backendSessionId: sessionId,
            model: request.model ?? 'default',
            permissionMode: request.permissionMode,
            cwd: request.cwd,
            billing: 'subscription',
          },
        },
      });
  }

  /**
   * Completes the turn with a final message, as an agent reporting its result: the same
   * replies a scripted backend gives (`designDone`, `implementationDone`, …).
   */
  release({ resultText }: Pick<ScriptedReply, 'resultText'>): void {
    this.push({
      type: 'event',
      event: { kind: 'assistant-message', payload: { text: resultText } },
    });
    this.push({
      type: 'event',
      event: {
        kind: 'turn-completed',
        payload: { outcome: 'success', resultText, costUsd: 0.1, turns: 1, durationMs: 5 },
      },
    });
  }

  /** Ends the turn with a model-service failure and exits, as the vendor CLI does. */
  failWithService(providerFailure: ProviderFailure): void {
    this.push({
      type: 'event',
      event: {
        kind: 'turn-completed',
        payload: {
          outcome: 'error',
          resultText: providerFailure.message,
          providerFailure,
          turns: 1,
          durationMs: 5,
        },
      },
    });
    this.exit(1, null);
  }

  /** The process dies mid-turn without a result. */
  crash(): void {
    this.exit(1, null);
  }

  /** Something other than the daemon kills the process (OOM killer, service manager). */
  killedBy(signal: string): void {
    this.exit(null, signal);
  }

  readonly items: AsyncIterable<AgentSessionItem> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<AgentSessionItem>> => {
        const item = this.queue.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    }),
  };

  private push(item: AgentSessionItem): void {
    const resolve = this.waiter;
    this.waiter = undefined;
    if (resolve !== undefined) resolve({ value: item, done: false });
    else this.queue.push(item);
  }

  send(): boolean {
    return !this.closed;
  }

  end(): void {
    this.exit(0, null);
  }

  kill(): void {
    this.exit(null, 'SIGTERM');
  }

  private exit(exitCode: number | null, signal: string | null): void {
    if (this.closed) return;
    this.push({ type: 'exited', exitCode, signal });
    this.closed = true;
  }
}

export class HeldBackend implements AgentBackend {
  readonly kind = 'claude-code' as const;
  readonly sessions: HeldSession[] = [];
  withoutSessionId = false;
  failResumes = false;

  describe() {
    return {
      kind: this.kind,
      label: 'Held',
      executable: '/fake/claude',
      models: [],
      catalog: { source: 'fallback' as const },
    };
  }

  listModels() {
    return Promise.resolve({ models: [], status: { source: 'fallback' as const } });
  }

  launch(request: AgentLaunchRequest): Promise<AgentSession> {
    if (this.failResumes && request.resumeSessionId !== undefined)
      return Promise.reject(new Error('No conversation found with that session id'));
    const session = new HeldSession(
      request,
      this.withoutSessionId ? undefined : `vendor-session-${this.sessions.length + 1}`,
    );
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  get launches(): readonly AgentLaunchRequest[] {
    return this.sessions.map((session) => session.request);
  }

  /** The most recently launched session. */
  get latest(): HeldSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error('No session launched');
    return session;
  }
}

export interface CycleFixture extends SignedIn {
  readonly services: ServiceSet;
  readonly backend: HeldBackend;
  readonly headers: Record<string, string>;
  readonly repositoryId: string;
  readonly worktreeId: WorktreeId;
}

export async function createCycleFixture(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    /** Keeps the daemon's own controller loops running instead of stepping them (R-B5). */
    readonly workers?: boolean;
    /** Git operations over the real ones, such as one that holds a launch's preflight. */
    readonly git?: (real: GitOperations) => GitOperations;
    /** Leaves the two items independent: no required edge from item-1 to item-2. */
    readonly independent?: boolean;
    readonly now?: () => Date;
    /** The controller kernel's clock (R-B5); give `now` from the same clock. */
    readonly kernelClock?: import('../src/services/kernel/controller-kernel.js').KernelClock;
  } = {},
): Promise<CycleFixture> {
  const backend = new HeldBackend();
  const real = createGitOperations({ gitExecutable: 'git' });
  const context = await createTestContext({
    gitOperations: options.git ? options.git(real) : real,
    agentBackends: new Map([[backend.kind, backend]]),
    workers: options.workers ?? false,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.kernelClock === undefined ? {} : { kernelClock: options.kernelClock }),
  });
  contexts.push(context);
  if (options.workers) markFreeRunning(context);
  const signedIn = await signIn(context, asWorkItemId('item-1'));
  const { workspaceId, userId } = signedIn;
  const at = '2026-09-23T00:00:00.000Z';
  context.storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: asProjectId('project-1'),
      workspaceId,
      name: 'Cycle project',
      slug: 'cycle-project',
      createdAt: at,
      createdByUserId: userId,
    });
    tx.planning.bundles.insert({
      id: asPlanBundleId('bundle-1'),
      workspaceId,
      projectId: asProjectId('project-1'),
      logicalName: 'cycle',
      createdAt: at,
    });
    tx.planning.versions.insert({
      id: asPlanVersionId('version-1'),
      workspaceId,
      projectId: asProjectId('project-1'),
      bundleId: asPlanBundleId('bundle-1'),
      versionNumber: 1,
      contentDigest: 'e'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'plan.md',
      normalizedSource: { document: 'plan.md' },
      itemCount: 2,
      requiredDependencyCount: options.independent ? 0 : 1,
      createdAt: at,
      createdByUserId: userId,
    });
    tx.planning.workItems.insertMany(
      ['item-1', 'item-2'].map((id, ordinal) => ({
        id: asWorkItemId(id),
        workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        sourceId: `AQ-0${ordinal + 1}`,
        ordinal,
        title: `Item ${ordinal + 1}`,
        risk: 'low' as const,
        primaryAreas: [],
        exitGate: 'Done',
        sourceFields: { id: `AQ-0${ordinal + 1}` },
      })),
    );
    if (!options.independent)
      tx.planning.dependencies.insertMany([
        {
          id: asWorkItemDependencyId('edge'),
          workspaceId,
          planVersionId: asPlanVersionId('version-1'),
          predecessorWorkItemId: asWorkItemId('item-1'),
          successorWorkItemId: asWorkItemId('item-2'),
          kind: 'required',
          ordinal: 0,
        },
      ]);
  });
  const headers = mutationHeaders(signedIn);
  const root = fixtureRepository();
  const inject = async (url: string, payload: Record<string, unknown>) => {
    const response = await context.app.inject({ method: 'POST', url, headers, payload });
    if (response.statusCode !== 200)
      throw new Error(`${url}: ${response.statusCode} ${response.body}`);
    return response.json();
  };
  const repositoryId = registerSourceRepositoryResponseSchema.parse(
    await inject(`/api/workspaces/${workspaceId}/repositories`, {
      rootPath: root,
      displayName: 'Fixture',
    }),
  ).repository.id;
  await inject(`/api/workspaces/${workspaceId}/plan-versions/version-1/branch-settings`, {
    repositoryId,
    integrationBranch: 'main',
    expectedVersion: 0,
  });
  const worktree = createWorktreeResponseSchema.parse(
    await inject(`/api/workspaces/${workspaceId}/work-items/item-1/worktrees`, {
      repositoryId,
    }),
  ).worktree;
  await inject(`/api/workspaces/${workspaceId}/work-items/item-1/control`, { action: 'admit' });
  return {
    ...signedIn,
    services: context.services,
    backend,
    headers,
    repositoryId,
    worktreeId: worktree.id,
  };
}

export function storedCycle(f: CycleFixture, id: string): WorkCycle {
  const found = f.context.storage.execution.cycles.find(f.workspaceId, id as WorkCycle['id']);
  if (!found) throw new Error('Missing cycle');
  return found;
}

export function storedRun(f: CycleFixture, id: string): AgentRun | undefined {
  return f.context.storage.execution.runs.find(f.workspaceId, id as AgentRun['id']);
}

export function runFinished(f: CycleFixture, id: string) {
  const event = f.context.storage.execution.runEvents.latestOfKind(
    f.workspaceId,
    id as AgentRun['id'],
    'run-finished',
  );
  return event?.kind === 'run-finished' ? event.payload : undefined;
}

/**
 * A clock tests move by hand, for the daemon's `now` and the controller kernel's timers (R-B5):
 * a timer fires only when `advance` passes its time, so nothing but a mark wakes the kernel
 * meanwhile (no sweep, no due time), and a test can tell which mark did. Timers run on their own
 * monotonic time, as Node's do; `step` moves only the wall clock, as a clock change does.
 */
export class ManualClock {
  private wall: number;
  private monotonic = 0;
  private readonly timers = new Map<number, { readonly at: number; readonly fire: () => void }>();
  private next = 0;

  constructor(start = Date.parse('2026-10-19T12:00:00.000Z')) {
    this.wall = start;
  }

  readonly now = (): number => this.wall;
  readonly date = (): Date => new Date(this.wall);

  readonly setTimeout = (fire: () => void, ms: number): unknown => {
    const handle = this.next++;
    this.timers.set(handle, { at: this.monotonic + Math.max(0, ms), fire });
    return handle;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Moves both clocks on, firing each timer whose time it passes, in time order. */
  advance(ms: number): void {
    const until = this.monotonic + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.wall += Math.max(0, due[1].at - this.monotonic);
      this.monotonic = Math.max(this.monotonic, due[1].at);
      due[1].fire();
    }
    this.wall += until - this.monotonic;
    this.monotonic = until;
  }

  /** Steps the wall clock alone, firing nothing, as a clock set by the system would. */
  step(ms: number): void {
    this.wall += ms;
  }
}
