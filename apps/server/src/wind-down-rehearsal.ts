import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  CLAUDE_CODE_MODELS,
  ClaudeCodeBackend,
  CODEX_MODELS,
  CodexBackend,
} from '@craftingtable/agents';
import type { AgentBackend } from '@craftingtable/agents';
import {
  type AgentBackendKind,
  type CleanupAction,
  DEFAULT_COMPLETION_POLICY,
  type PlanVersionId,
  type ProjectId,
  type RetirementChoice,
  type RetirementDisposition,
  type Roadmap,
  type RoadmapEntryId,
  type RoadmapId,
  type SessionId,
  startedAttempts,
  type WorkspaceId,
  asRoadmapId,
} from '@craftingtable/domain';
import { createGitOperations, type GitTrust } from '@craftingtable/git';
import { inspectPlanArchive, readArchive } from '@craftingtable/planning';
import {
  type CraftingTableStorage,
  copyDatabaseImmutably,
  relocateRehearsalCopy,
} from '@craftingtable/storage';
import { createServices } from './composition.js';
import { verifyDatabase } from './db-verify.js';
import { configFromEnv } from './config.js';
import { openDaemonStorage, verified } from './persisted-records.js';
import type { AuthContext } from './services/auth-service.js';
import { ExecutionRequestError } from './services/errors.js';

/**
 * Rehearses a roadmap's wind-down and cleanup on copies (R-B11 done-when 1 and 2), never on the
 * live daemon's data:
 *
 *   pnpm rehearse:wind-down --database <live sqlite> --out <new directory> --roadmap <id>
 *     [--retire <planVersionId>=superseded|parked]... [--activate-revision <planVersionId>]
 *     [--capacity-probe <planVersionId>]
 *
 * The live database is read only with `?immutable=1` into a copy, which migrates on open. The
 * repositories the roadmap's records name are copied with every managed worktree of theirs
 * (Cargo build caches left out), relinked to each other as `git worktree repair` would, and the
 * copy is moved onto them; any other repository points at a path that does not exist. The real
 * services then run on the copy with real Git and no agent: the wind-down's preview and command,
 * and the cleanup's. `--capacity-probe` saves, before the wind-down, a draft roadmap of a revised
 * copy of a version about to be retired and records whether its first entry is
 * capacity-blocked before and after; `--activate-revision` imports, after it, the version's own
 * files again (refused) and then a revised copy with "Make active". The report records each
 * figure, every ref that moved, and whether everything outside the roadmap stayed as it was.
 * `git fsck` of each copied repository is the rehearser's last step; the report names them.
 */

interface Options {
  readonly database: string;
  readonly out: string;
  readonly roadmapId: RoadmapId;
  readonly retire: readonly RetirementChoice[];
  readonly activateRevision?: string;
  readonly capacityProbe?: string;
}

function options(argv: readonly string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const all = (flag: string) =>
    argv.flatMap((arg, index) => (arg === flag && argv[index + 1] ? [argv[index + 1]!] : []));
  const database = value('--database');
  const out = value('--out');
  const roadmapId = value('--roadmap');
  if (!database || !out || !roadmapId)
    throw new Error(
      'Usage: rehearse:wind-down --database <live sqlite> --out <new directory> --roadmap <id> [--retire <planVersionId>=superseded|parked]... [--activate-revision <planVersionId>] [--capacity-probe <planVersionId>]',
    );
  const retire = all('--retire').map((pair) => {
    const [planVersionId, disposition] = pair.split('=');
    if (!planVersionId || (disposition !== 'superseded' && disposition !== 'parked'))
      throw new Error(`--retire ${pair}: name a plan version and superseded or parked`);
    return {
      planVersionId: planVersionId as PlanVersionId,
      disposition: disposition as RetirementDisposition,
    };
  });
  const activateRevision = value('--activate-revision');
  const capacityProbe = value('--capacity-probe');
  return {
    database: resolve(database),
    out: resolve(out),
    roadmapId: asRoadmapId(roadmapId),
    retire,
    ...(activateRevision ? { activateRevision } : {}),
    ...(capacityProbe ? { capacityProbe } : {}),
  };
}

/** A Cargo build directory: rebuilt on demand, never needed to rehearse refs. */
const buildCache = (path: string) => existsSync(join(path, 'CACHEDIR.TAG'));

function copyTree(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    filter: (path) => !buildCache(path),
  });
}

/** A ZIP of stored (uncompressed) entries, which the plan archive reader accepts. */
function zip(entries: readonly { readonly path: string; readonly bytes: Uint8Array }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const data = Buffer.from(entry.bytes);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A version's own archive, and a revised copy whose implementation plan says it is one. */
function archives(storage: CraftingTableStorage, ws: WorkspaceId, planVersionId: string) {
  const link = storage.imports.planLinks(ws, planVersionId as PlanVersionId)[0];
  const archive = link && storage.imports.archive(ws, link.archiveId);
  if (!link || !archive) throw new Error(`Plan version ${planVersionId} has no stored archive`);
  const original = Buffer.from(archive.content);
  const entries = readArchive(original);
  const plan = entries.find((entry) => entry.path === link.implementationPlan);
  if (!plan) throw new Error(`The archive of ${planVersionId} lacks its implementation plan`);
  const revisedPlan = Buffer.concat([
    Buffer.from(plan.bytes),
    Buffer.from('\n\n<!-- Revised for the R-B11 wind-down rehearsal. -->\n'),
  ]);
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  // Documents and checksum manifests that name a changed file's digest follow it, and a document
  // changed that way changes its own digest in turn: rewritten until nothing more changes.
  let files = entries.map((entry) => ({
    path: entry.path,
    bytes: entry.path === plan.path ? revisedPlan : Buffer.from(entry.bytes),
  }));
  const moved = new Map([[plan.sha256, sha(revisedPlan)]]);
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    files = files.map((file) => {
      if (file.path === plan.path) return file;
      let text = Buffer.from(file.bytes).toString('utf8');
      for (const [from, to] of moved) text = text.split(from).join(to);
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.equals(Buffer.from(file.bytes))) return file;
      const from = sha(file.bytes);
      if (!moved.has(from)) {
        moved.set(from, sha(bytes));
        changed = true;
      }
      return { path: file.path, bytes };
    });
    if (!changed) break;
  }
  const revised = zip(files);
  const selection = {
    implementationPlan: link.implementationPlan,
    workBreakdown: link.workBreakdown,
  };
  return { filename: archive.filename, original, revised, selection };
}

const code = (error: unknown) =>
  error instanceof ExecutionRequestError ? (error.detail?.reason ?? error.code) : String(error);

async function main(): Promise<void> {
  const o = options(process.argv.slice(2));
  if (existsSync(o.out)) throw new Error(`${o.out} already exists; choose a new directory`);
  const dataDir = join(o.out, 'data');
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  const copy = join(dataDir, 'state', 'craftingtable.sqlite');
  const started = new Date().toISOString();
  copyDatabaseImmutably(o.database, copy);
  // An immutable read during a checkpoint can mix moments: the copy must pass db:verify's record,
  // integrity and foreign-key checks (review N4). A checkpointed database copies whole.
  const verification = await verifyDatabase(copy);
  if (!verified(verification))
    throw new Error(
      `The copy fails db:verify (${verification.invalid.length} invalid, ${verification.unreadable.length} unreadable, ${verification.integrity.join('; ') || 'integrity ok'}); copy it again`,
    );

  // What to copy, read from the copy itself.
  const first = openDaemonStorage(copy);
  let moves: Parameters<typeof relocateRehearsalCopy>[1];
  let workspaceId: WorkspaceId;
  try {
    const roadmap = first.roadmaps.list().find((r) => r.id === o.roadmapId);
    if (!roadmap) throw new Error(`No roadmap ${o.roadmapId} in the snapshot`);
    workspaceId = roadmap.workspaceId;
    const retired = new Set<string>(o.retire.map((r) => r.planVersionId));
    const versionOf = (tree: { planVersionId?: string; workItemId?: string }) =>
      tree.planVersionId ??
      (tree.workItemId
        ? first.planning.workItems.find(roadmap.workspaceId, tree.workItemId as never)
            ?.planVersionId
        : undefined);
    const named = new Set<string>([
      ...startedAttempts(roadmap).map((a) => a.worktreeId),
      ...(roadmap.decisionPreparations ?? []).map((p) => p.worktreeId),
    ]);
    const repositoryIds = new Set<string>([
      ...roadmap.definition.entries.map((e) => e.repositoryId),
      ...(roadmap.decisionPreparations ?? []).map((p) => p.repositoryId),
      ...first.execution.worktrees
        .listForWorkspace(roadmap.workspaceId)
        .filter((t) => named.has(t.id) || retired.has(versionOf(t) ?? ''))
        .map((t) => t.repositoryId),
    ]);
    const repositories: { id: string; rootPath: string }[] = [];
    const worktrees: { id: string; path: string }[] = [];
    for (const id of repositoryIds) {
      const repo = first.execution.sourceRepositories.find(roadmap.workspaceId, id as never);
      if (!repo) continue;
      const root = join(o.out, 'repositories', basename(repo.rootPath));
      copyTree(repo.rootPath, root);
      // A checkout whose Git directory is a link, a file (itself a linked worktree) or shares a
      // common directory would reach the live repository: refused (review N4).
      const gitDir = join(root, '.git');
      if (!lstatSync(gitDir).isDirectory() || existsSync(join(gitDir, 'commondir')))
        throw new Error(`${repo.rootPath} has no Git directory of its own; it cannot be copied`);
      repositories.push({ id, rootPath: root });
      // Every managed worktree of the repository, other roadmaps' too, relinked to the copy.
      const linked = new Set<string>();
      for (const tree of first.execution.worktrees.listActive()) {
        if (tree.repositoryId !== id || !existsSync(tree.path)) continue;
        const destination = join(o.out, 'worktrees', basename(repo.rootPath), basename(tree.path));
        copyTree(tree.path, destination);
        const pointer = readFileSync(join(destination, '.git'), 'utf8');
        const entry = basename(/^gitdir: (.+)$/m.exec(pointer)?.[1]?.trim() ?? '');
        const metadata = join(root, '.git', 'worktrees', entry);
        if (!entry || !existsSync(metadata))
          throw new Error(`${tree.path} is not a linked worktree of ${repo.rootPath}`);
        writeFileSync(join(destination, '.git'), `gitdir: ${metadata}\n`);
        writeFileSync(join(metadata, 'gitdir'), `${join(destination, '.git')}\n`);
        linked.add(entry);
        worktrees.push({ id: tree.id, path: destination });
      }
      // A worktree of the live repository that no record names is not part of the copy.
      const entries = join(root, '.git', 'worktrees');
      if (existsSync(entries))
        for (const entry of readdirSync(entries))
          if (!linked.has(entry)) rmSync(join(entries, entry), { recursive: true, force: true });
    }
    moves = { repositories, worktrees, absentRoot: join(o.out, 'absent') };
  } finally {
    first.close();
  }
  relocateRehearsalCopy(copy, moves);

  const storage = openDaemonStorage(copy);
  const config = configFromEnv({
    CRAFTINGTABLE_DATA_DIR: dataDir,
    CRAFTINGTABLE_CONFIG_DIR: join(dataDir, 'config'),
    CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
    CRAFTINGTABLE_LOG_LEVEL: 'silent',
    CRAFTINGTABLE_WEB_DIST: '',
    CRAFTINGTABLE_REPOSITORY_ROOTS: join(o.out, 'repositories'),
  });
  // No agent can start: the executables do not exist, and no controller worker runs.
  const missing = join(dataDir, 'no-agent-executable');
  const services = await createServices(storage, config, {
    gitOperations: (gitTrust: () => GitTrust) =>
      createGitOperations({ gitExecutable: 'git', gitTrust }),
    agentBackends: new Map<AgentBackendKind, AgentBackend>([
      ['claude-code', new ClaudeCodeBackend({ executable: missing, models: CLAUDE_CODE_MODELS })],
      ['codex', new CodexBackend({ executable: missing, models: CODEX_MODELS })],
    ]),
    notificationTransport: { send: async () => ({ status: 'accepted' }) },
    // The copy as the live daemon left it: no restart recovery rewrites anything.
    restartRecovery: false,
  });
  const git = createGitOperations({ gitExecutable: 'git' });
  try {
    const report = await rehearse(o, storage, services, git, workspaceId, moves);
    const result = {
      rehearsal: 'R-B11 wind-down and cleanup',
      startedAt: started,
      finishedAt: new Date().toISOString(),
      database: o.database,
      copy,
      schema: storage.migrationStatus,
      ...report,
      fsck: moves.repositories.map((r) => `git -C ${r.rootPath} fsck --no-progress`),
    };
    writeFileSync(join(o.out, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    storage.close();
  }
}

type Services = Awaited<ReturnType<typeof createServices>>;
type Git = ReturnType<typeof createGitOperations>;

async function rehearse(
  o: Options,
  storage: CraftingTableStorage,
  services: Services,
  git: Git,
  ws: WorkspaceId,
  moves: Parameters<typeof relocateRehearsalCopy>[1],
) {
  const roadmap = storage.roadmaps.find(ws, o.roadmapId) as Roadmap;
  const actor = storage.users.findById(roadmap.delegatedByUserId ?? roadmap.createdByUserId);
  if (!actor) throw new Error('The roadmap names no user');
  const at = new Date();
  const session = storage.sessions.insert({
    id: randomUUID() as SessionId,
    userId: actor.id,
    tokenDigest: randomBytes(32).toString('hex'),
    csrfToken: randomBytes(16).toString('hex'),
    createdAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 3600_000).toISOString(),
    userAgent: 'R-B11 wind-down rehearsal',
  });
  const context: AuthContext = { user: actor, session };

  // Everything outside the roadmap, as it stands before: other roadmaps with their worktrees and
  // cycles, projects' active versions, and every ref of the copied repositories.
  const outside = () =>
    new Map(
      storage.roadmaps
        .list()
        .filter((r) => r.id !== o.roadmapId)
        .map((r) => [
          r.id,
          JSON.stringify({
            roadmap: r,
            worktrees: startedAttempts(r).map((a) =>
              storage.execution.worktrees.find(r.workspaceId, a.worktreeId),
            ),
            cycles: startedAttempts(r).map((a) =>
              storage.execution.cycles.find(r.workspaceId, a.cycleId),
            ),
          }),
        ]),
    );
  const refs = async () =>
    Object.fromEntries(
      await Promise.all(
        moves.repositories.map(async (r) => {
          const heads = await git.branchHeads(r.rootPath);
          if (!heads.ok) throw new Error(heads.failure.message);
          return [r.rootPath, heads.value.heads] as const;
        }),
      ),
    );
  const outsideBefore = outside();
  const refsBefore = await refs();
  const retiring = new Set<string>(o.retire.map((r) => r.planVersionId));
  const projectsBefore = storage.planning.projects
    .list(ws)
    .filter((p) => !p.activePlanVersionId || !retiring.has(p.activePlanVersionId));

  // A draft of a revised copy of a version about to be retired, to read its capacity.
  let probe: { roadmapId: RoadmapId; before?: string; after?: string } | undefined;
  if (o.capacityProbe) {
    const version = storage.planning.versions.find(ws, o.capacityProbe as PlanVersionId);
    const settings = storage.execution.branchSettings.find(ws, o.capacityProbe as PlanVersionId);
    if (!version || !settings) throw new Error('The capacity probe needs a configured version');
    const files = archives(storage, ws, o.capacityProbe);
    const imported = services.packageImportService.importPlan(
      context,
      ws,
      files.filename,
      files.revised,
      {
        ...files.selection,
        archiveDigest: inspectPlanArchive(files.revised).archiveDigest,
        projectId: version.projectId as ProjectId,
        activate: false,
      },
    );
    const probePlan = 'plan' in imported ? imported.plan : undefined;
    if (probePlan?.outcome !== 'succeeded')
      throw new Error(
        `The revised probe plan was not imported: ${JSON.stringify(probePlan ?? imported.attempt)}`,
      );
    const revision = probePlan.version.id;
    await services.executionService.branches.save(context, ws, revision, {
      repositoryId: settings.repositoryId,
      integrationBranch: settings.integrationBranch,
      expectedVersion: 0,
    });
    const item = storage.planning.workItems.listForVersion(ws, revision)[0];
    if (!item) throw new Error('The revised probe plan has no work item');
    const id = randomUUID() as RoadmapId;
    services.roadmapService.save(context, ws, id, {
      expectedVersion: 0,
      name: 'R-B11 rehearsal capacity probe',
      entries: [
        {
          id: randomUUID() as RoadmapEntryId,
          workItemId: item.id,
          permissions: { design: 'auto', implement: 'auto', review: 'auto', remediate: 'auto' },
          policy: DEFAULT_COMPLETION_POLICY,
          instructions: '',
        },
      ],
    } as never);
    const status = () =>
      services.roadmapService.list(context, ws).find((v) => v.roadmap.id === id)?.progress[0]
        ?.status;
    probe = { roadmapId: id, before: status() };
    Object.assign(probe, { revision });
  }

  const preview = services.roadmapService.windDownView(context, ws, o.roadmapId).preview;
  const view = await services.roadmapService.windDown(context, ws, o.roadmapId, {
    expectedDigest: preview.digest,
    retire: o.retire,
  });
  if (probe)
    probe.after = services.roadmapService
      .list(context, ws)
      .find((v) => v.roadmap.id === probe!.roadmapId)?.progress[0]?.status;

  let activation: Record<string, unknown> | undefined;
  if (o.activateRevision) {
    const version = storage.planning.versions.find(ws, o.activateRevision as PlanVersionId);
    if (!version) throw new Error('No version to revise');
    const files = archives(storage, ws, o.activateRevision);
    let identical: string;
    try {
      services.packageImportService.importPlan(context, ws, files.filename, files.original, {
        ...files.selection,
        archiveDigest: inspectPlanArchive(files.original).archiveDigest,
        projectId: version.projectId as ProjectId,
        activate: true,
      });
      identical = 'imported';
    } catch (error) {
      identical = code(error);
    }
    const project = storage.planning.projects.find(ws, version.projectId);
    const revised = services.packageImportService.importPlan(
      context,
      ws,
      files.filename,
      files.revised,
      {
        ...files.selection,
        archiveDigest: inspectPlanArchive(files.revised).archiveDigest,
        projectId: version.projectId as ProjectId,
        activate: true,
        ...(project?.activePlanVersionId
          ? { expectedActivePlanVersionId: project.activePlanVersionId }
          : {}),
      },
    );
    const revisedResult = 'plan' in revised ? revised.plan : undefined;
    const revisedPlan = revisedResult?.outcome === 'failed-validation' ? undefined : revisedResult;
    activation = {
      projectId: version.projectId,
      identicalReimport: identical,
      outcome: revisedResult?.outcome ?? revised.attempt.outcome,
      revision: revisedPlan?.version.id ?? null,
      versionNumber: revisedPlan?.version.versionNumber ?? null,
      active:
        revisedPlan !== undefined &&
        storage.planning.projects.find(ws, version.projectId)?.activePlanVersionId ===
          revisedPlan.version.id,
    };
  }

  const plan = await services.repositoryCleanupService.view(context, ws, o.roadmapId);
  const planned = plan.preview;
  if (!planned) throw new Error('No cleanup preview');
  const cleaned = await services.repositoryCleanupService.clean(context, ws, o.roadmapId, {
    expectedDigest: planned.digest,
    discardDirty: false,
  });
  const refsAfter = await refs();

  // What moved, by repository: deleted branches, created tags, and anything else (none).
  const movedRefs = Object.fromEntries(
    Object.entries(refsBefore).map(([repo, before]) => {
      const after = refsAfter[repo] ?? {};
      const deleted = Object.keys(before).filter((ref) => !(ref in after));
      const created = Object.keys(after).filter((ref) => !(ref in before));
      const changed = Object.keys(before).filter(
        (ref) => ref in after && after[ref] !== before[ref],
      );
      return [
        repo,
        {
          before: Object.keys(before).length,
          after: Object.keys(after).length,
          deleted: deleted.sort(),
          created: created.sort().map((ref) => `${ref} ${after[ref]}`),
          changed,
          remainingCt: Object.keys(after).filter((ref) => ref.startsWith('refs/heads/ct/')),
          // Every ref that is not a `ct/*` branch, at the same commit after as before.
          protectedUnchanged: Object.keys(before)
            .filter((ref) => !ref.startsWith('refs/heads/ct/'))
            .map(
              (ref) =>
                `${ref} ${before[ref]?.slice(0, 7)} ${after[ref] === before[ref] ? 'kept' : 'MOVED'}`,
            ),
        },
      ];
    }),
  );
  const tally = (actions: readonly CleanupAction[]) => {
    const counts: Record<string, number> = {};
    for (const a of actions) {
      const keeper = a.kind === 'delete-branch' ? `:${a.keeper.kind}` : '';
      const key = `${a.kind}${keeper}:${a.state}${a.code ? `:${a.code}` : ''}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };
  return {
    roadmapId: o.roadmapId,
    windDown: {
      preview: {
        status: preview.status,
        cycles: preview.cycles.map((c) => `${c.label} ${c.status}`),
        livePreparations: preview.preparations.length,
        amendment: preview.amendmentId ?? null,
        attention: preview.attention.map((a) => `${a.code}: ${a.title}`),
        versions: preview.versions.map((v) => ({
          planVersionId: v.planVersionId,
          project: v.projectName,
          version: v.versionNumber,
          active: v.active,
          admittedItems: v.admittedItems,
          activeWorktrees: v.activeWorktrees,
          refusal: v.refusal?.code ?? null,
        })),
        refusals: preview.refusals.map((r) => r.code),
      },
      record: view.record,
      roadmapStatus: storage.roadmaps.find(ws, o.roadmapId)?.status,
      retired: storage.windDowns.retirements(ws),
      openItemsOfRoadmap: storage.attention
        .open(ws)
        .filter((i) => i.refs.roadmapId === o.roadmapId)
        .map((i) => i.code),
    },
    capacityProbe: probe ?? null,
    activation: activation ?? null,
    cleanup: {
      preview: {
        actions: planned.actions.length,
        tally: tally(planned.actions),
        parked: planned.actions.flatMap((a) =>
          a.kind === 'delete-branch' && a.keeper.kind === 'parked-tag'
            ? [`${a.branchName} ${a.tipSha} -> ${a.keeper.tag}`]
            : [],
        ),
        refusals: planned.refusals.map((r) => r.code),
      },
      result: cleaned.latest
        ? {
            status: cleaned.latest.status,
            tally: tally(cleaned.latest.actions),
            kept: cleaned.latest.actions
              .filter((a) => a.state === 'kept' || a.state === 'refused')
              .map((a) => `${a.kind} ${a.branchName} ${a.state} ${a.code ?? ''} ${a.note ?? ''}`),
          }
        : null,
    },
    refs: movedRefs,
    // Every other roadmap that existed before, with its worktrees and cycles, as it was.
    outsideChanged: [...outsideBefore].flatMap(([id, before]) =>
      outside().get(id) === before ? [] : [id],
    ),
    outsideCompared: outsideBefore.size,
    otherProjectsUntouched:
      JSON.stringify(projectsBefore.map((p) => storage.planning.projects.find(ws, p.id))) ===
        JSON.stringify(projectsBefore) ||
      // The activation step changes only the revised project's active version.
      projectsBefore
        .filter((p) => p.id !== (activation?.projectId as string | undefined))
        .every(
          (p) => JSON.stringify(storage.planning.projects.find(ws, p.id)) === JSON.stringify(p),
        ),
  };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
