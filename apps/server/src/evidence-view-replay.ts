import { join } from 'node:path';
import {
  evidenceSubmissionSchema,
  runtimeEvidenceViewSchema,
  type RuntimeEvidenceView,
} from '@craftingtable/contracts';
import type { AgentBackend } from '@craftingtable/agents';
import type { AgentBackendKind } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import { createServices } from './composition.js';
import { configFromEnv } from './config.js';
import { openDaemonStorage } from './persisted-records.js';
import type { AuthContext } from './services/auth-service.js';

/**
 * Renders each map definition's evidence view (`GET …/concurrency-definitions/:id/runtime`)
 * over a database snapshot, and measures it (R-H4, LIVE-29).
 *
 * The scheduler replays never read this view, so its content needs a golden of its own. Git
 * is stubbed: every call fails the same way, so pin and candidate freshness read as
 * unavailable, deterministically, and the calls are counted. The view is read as the user
 * who imported the definition; it only checks membership.
 */

type EvidenceSubmissionRecord = ReturnType<typeof evidenceSubmissionSchema.parse>;
export interface EvidenceViewReplay {
  readonly definitionId: string;
  readonly workspaceId: string;
  /** The view as the route sends it, after its schema. */
  readonly view: RuntimeEvidenceView;
  /**
   * Each listed submission's full record, read on demand as the browser does. Absent in
   * goldens recorded before R-H4, whose view carried the full records.
   */
  readonly records?: readonly EvidenceSubmissionRecord[];
}
export interface EvidenceViewMeasure {
  readonly definitionId: string;
  /** Size of the route's JSON body. */
  readonly bytes: number;
  /** Bytes by top-level field. */
  readonly fields: Readonly<Record<string, number>>;
  /** CPU of the view, its schema and its serialization, in ms: each of `runs` requests. */
  readonly cpuMs: readonly number[];
  readonly gitCalls: number;
}

/** Runs over `database`, which it may migrate: pass a copy. */
export async function replayEvidenceViews(
  database: string,
  dataDir: string,
  now: Date,
  runs = 3,
): Promise<{ views: EvidenceViewReplay[]; measures: EvidenceViewMeasure[] }> {
  const storage = openDaemonStorage(database);
  try {
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: dataDir,
      // Its own credentials file, never the operator's (R-G9).
      CRAFTINGTABLE_CONFIG_DIR: join(dataDir, 'config'),
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
    const services = await createServices(storage, config, {
      gitOperations: git,
      agentBackends: new Map<AgentBackendKind, AgentBackend>(),
      now: () => now,
      notificationTransport: { send: async () => ({ status: 'accepted' }) },
      restartRecovery: false,
    });
    const views: EvidenceViewReplay[] = [];
    const measures: EvidenceViewMeasure[] = [];
    const definitions = storage.workspaces
      .listActiveIds()
      .flatMap((ws) => storage.imports.definitions(ws));
    for (const { id, workspaceId: ws, createdByUserId } of definitions) {
      const user = storage.users.findById(createdByUserId);
      if (!user || !storage.workspaces.findAuthorized(user.id, ws)) continue;
      // The view checks membership only; no session is read.
      const context = { user } as AuthContext;
      const cpuMs: number[] = [];
      let view: RuntimeEvidenceView | undefined;
      let body = '';
      gitCalls = 0;
      for (let run = 0; run < runs; run++) {
        const start = process.cpuUsage();
        view = runtimeEvidenceViewSchema.parse(
          await services.runtimeEvidenceService.view(context, ws, id),
        );
        body = JSON.stringify(view);
        const used = process.cpuUsage(start);
        cpuMs.push(Math.round((used.user + used.system) / 1000));
      }
      if (!view) continue;
      const records = view.submissions.map(({ submission }) =>
        evidenceSubmissionSchema.parse(
          services.runtimeEvidenceService.submission(context, ws, id, submission.id),
        ),
      );
      views.push({ definitionId: id, workspaceId: ws, view, records });
      measures.push({
        definitionId: id,
        bytes: Buffer.byteLength(body),
        fields: Object.fromEntries(
          Object.entries(view).map(([key, value]) => [
            key,
            Buffer.byteLength(JSON.stringify(value) ?? ''),
          ]),
        ),
        cpuMs,
        gitCalls: gitCalls / runs,
      });
    }
    return { views, measures };
  } finally {
    storage.close();
  }
}
