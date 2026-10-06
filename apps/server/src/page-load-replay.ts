import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AgentBackend } from '@craftingtable/agents';
import type { AgentBackendKind, UserId, WorkspaceId } from '@craftingtable/domain';
import { asSessionId } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import { createDaemon } from './composition.js';
import { configFromEnv, SESSION_COOKIE_NAME } from './config.js';
import { openDaemonStorage } from './persisted-records.js';

/**
 * Measures what a work item page costs the daemon to load, over a database snapshot (R-D5,
 * PERF-14): the requests the browser app makes for the page and the server time of each.
 *
 * The daemon is the real one (`createDaemon`, routes and access guard included) over a copy of
 * the snapshot, with its workers stopped and Git stubbed, so every Git-derived fact reads as
 * unavailable and the calls are counted, not timed. Each request goes through `inject`, so
 * "server time" is routing, the access check, the handler, its schema and serialization, with
 * no network. A session is written for a member of each workspace.
 *
 * The page's reads are listed in `workItemPageReads` as the browser app at this commit makes
 * them; a change to what the page reads changes that list in the same commit.
 */

export interface PageRead {
  readonly name: string;
  readonly url: string;
}
export interface PageReadMeasure extends PageRead {
  readonly status: number;
  /** The body's size as JSON. */
  readonly bytes: number;
  /** What crosses the wire to a browser, which accepts gzip (R-D5). */
  readonly wireBytes?: number;
  /** Median of the measured repetitions, in ms. */
  readonly ms: number;
  readonly gitCalls: number;
}
export interface PageLoadMeasure {
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly sourceId: string;
  readonly reads: readonly PageReadMeasure[];
  /** Sum of the reads' medians: the page's server time. */
  readonly totalMs: number;
  readonly totalBytes: number;
  readonly totalWireBytes?: number;
}
export interface PageLoadReplay {
  /** The shell's reads on a cold load (sign-in check, workspace list, snapshot, attention, cycles). */
  readonly shell: readonly PageReadMeasure[];
  readonly pages: readonly PageLoadMeasure[];
}

type Get = (url: string) => Promise<{ status: number; body: string }>;

/** The shell's reads on a cold load of any workspace page, before the page's own. */
export function shellReads(ws: string): PageRead[] {
  const base = `/api/workspaces/${ws}`;
  return [
    { name: 'session', url: '/api/auth/session' },
    { name: 'workspaces', url: '/api/workspaces' },
    { name: 'snapshot', url: `${base}/snapshot` },
    { name: 'attention', url: `${base}/attention` },
    { name: 'cycles', url: `${base}/cycles` },
  ];
}

/**
 * A work item page's reads as the browser app makes them on navigation, the shell's already
 * held (R-D5): its region in one read, then its plan's branches and, once those name a
 * repository, the plan's repository policy. A worktree's branch status is read only when the
 * operator checks it, so not here.
 */
export async function workItemPageReads(ws: string, item: string, get: Get): Promise<PageRead[]> {
  const base = `/api/workspaces/${ws}`;
  const view = { name: 'work-item-view', url: `${base}/work-items/${item}/view` };
  const answer = JSON.parse((await get(view.url)).body) as {
    detail?: { workItem?: { planVersionId: string } };
  };
  const planVersionId = answer.detail?.workItem?.planVersionId;
  const reads: PageRead[] = [view];
  if (planVersionId !== undefined) {
    const branches = {
      name: 'plan-branches',
      url: `${base}/plan-versions/${planVersionId}/branch-settings`,
    };
    reads.push(branches);
    const settings = JSON.parse((await get(branches.url)).body) as { settings?: unknown };
    if (settings.settings !== undefined)
      reads.push({
        name: 'repository-policy',
        url: `${base}/plan-versions/${planVersionId}/repository-policy`,
      });
  }
  return reads;
}

const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** Runs over `database`, which it may migrate: pass a copy. */
export async function replayPageLoads(
  database: string,
  dataDir: string,
  now: Date,
  repetitions = 5,
): Promise<PageLoadReplay> {
  const storage = openDaemonStorage(database);
  const config = configFromEnv({
    CRAFTINGTABLE_DATA_DIR: dataDir,
    CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
    CRAFTINGTABLE_LOG_LEVEL: 'silent',
    CRAFTINGTABLE_WEB_DIST: '',
  });
  let gitCalls = 0;
  const git = new Proxy({} as GitOperations, {
    get: (_target, method) => async () => {
      gitCalls++;
      return {
        ok: false,
        failure: { kind: 'spawn-failed', message: `Replay has no Git (${String(method)}).` },
      };
    },
  });
  const daemon = await createDaemon(storage, config, {
    overrides: {
      gitOperations: git,
      agentBackends: new Map<AgentBackendKind, AgentBackend>(),
      now: () => now,
      notificationTransport: { send: async () => ({ status: 'accepted' }) },
      restartRecovery: false,
    },
    server: { logger: false, startWorkers: false },
  });
  try {
    await daemon.app.ready();
    const shell: PageReadMeasure[] = [];
    const pages: PageLoadMeasure[] = [];
    for (const ws of storage.workspaces.listActiveIds()) {
      const userId = memberOf(storage, ws);
      if (userId === undefined) continue;
      const raw = randomBytes(32).toString('base64url');
      storage.transaction((tx) =>
        tx.sessions.insert({
          id: asSessionId(randomUUID()),
          userId,
          tokenDigest: createHash('sha256').update(raw, 'utf8').digest('hex'),
          csrfToken: randomBytes(32).toString('base64url'),
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        }),
      );
      const get: Get = async (url) => {
        const response = await daemon.app.inject({
          method: 'GET',
          url,
          cookies: { [SESSION_COOKIE_NAME]: raw },
        });
        return { status: response.statusCode, body: response.body };
      };
      const measure = async (read: PageRead): Promise<PageReadMeasure> => {
        const times: number[] = [];
        let status = 0;
        let bytes = 0;
        let wireBytes = 0;
        await get(read.url);
        gitCalls = 0;
        for (let run = 0; run < repetitions; run++) {
          // As a browser asks: gzip accepted, and no validator held (a first read).
          const start = performance.now();
          const response = await daemon.app.inject({
            method: 'GET',
            url: read.url,
            cookies: { [SESSION_COOKIE_NAME]: raw },
            headers: { 'accept-encoding': 'gzip' },
          });
          times.push(performance.now() - start);
          status = response.statusCode;
          wireBytes = response.rawPayload.length;
        }
        bytes = Buffer.byteLength((await get(read.url)).body);
        return {
          ...read,
          status,
          bytes,
          wireBytes,
          ms: Math.round(median(times) * 10) / 10,
          gitCalls: gitCalls / repetitions,
        };
      };
      for (const read of shellReads(ws)) shell.push(await measure(read));
      const agenda = JSON.parse(
        (await get(`/api/workspaces/${ws}/work-items?filter=all`)).body,
      ) as { items?: readonly { id: string; sourceId: string }[] };
      for (const item of agenda.items ?? []) {
        const reads: PageReadMeasure[] = [];
        for (const read of await workItemPageReads(ws, item.id, get))
          reads.push(await measure(read));
        pages.push({
          workspaceId: ws,
          workItemId: item.id,
          sourceId: item.sourceId,
          reads,
          totalMs: Math.round(reads.reduce((sum, r) => sum + r.ms, 0) * 10) / 10,
          totalBytes: reads.reduce((sum, r) => sum + r.bytes, 0),
          totalWireBytes: reads.reduce((sum, r) => sum + (r.wireBytes ?? r.bytes), 0),
        });
      }
    }
    return { shell, pages };
  } finally {
    await daemon.close();
  }
}

/** A user who can read the workspace: whoever created its worktrees, runs or definitions. */
function memberOf(
  storage: ReturnType<typeof openDaemonStorage>,
  ws: WorkspaceId,
): UserId | undefined {
  const candidates = [
    ...storage.execution.worktrees.listActive(ws).map((t) => t.createdByUserId),
    ...storage.execution.runs.listRecent(ws, 20).map((r) => r.createdByUserId),
    ...storage.imports.definitions(ws).map((d) => d.createdByUserId),
  ];
  return candidates.find((id) => storage.workspaces.findAuthorized(id, ws) !== undefined);
}

/** A text summary: the shell, then pages by server time, heaviest first. */
export function formatPageLoads(replay: PageLoadReplay, top = 10): string {
  const lines: string[] = [];
  const shellMs = replay.shell.reduce((sum, r) => sum + r.ms, 0);
  lines.push(
    `shell (cold load, per workspace): ${replay.shell.map((r) => `${r.name} ${r.ms} ms ${r.bytes} B`).join(', ')}; total ${Math.round(shellMs * 10) / 10} ms`,
  );
  const pages = [...replay.pages].sort((a, b) => b.totalMs - a.totalMs);
  const totals = pages.map((p) => p.totalMs);
  const counts = pages.map((p) => p.reads.length);
  lines.push(
    `work item pages: ${pages.length}; requests median ${median(counts)}, max ${Math.max(...counts)}; server ms median ${median(totals)}, p90 ${[...totals].sort((a, b) => a - b)[Math.floor(totals.length * 0.9)] ?? 0}, max ${totals[0] ?? 0}`,
  );
  for (const page of pages.slice(0, top))
    lines.push(
      `  ${page.sourceId} (${page.workItemId}): ${page.reads.length} requests, ${page.totalMs} ms, ${page.totalBytes} B (${page.totalWireBytes} B on the wire)\n    ${page.reads
        .map(
          (r) =>
            `${r.name} ${r.ms} ms ${r.bytes} B${r.status === 200 ? '' : ` [${r.status}]`}${r.gitCalls ? ` git ${r.gitCalls}` : ''}`,
        )
        .join(', ')}`,
    );
  return `${lines.join('\n')}\n`;
}
