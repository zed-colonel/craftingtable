import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { lstat, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type SaveStorageRequest,
  type StorageStatus,
  storagePolicySchema,
} from '@craftingtable/contracts';
import type { AgentRunId, StoragePolicy, WorkspaceId, WorktreeId } from '@craftingtable/domain';
import type {
  CraftingTableStorage,
  StorageRootIdentity,
  StoredStorageSettings,
} from '@craftingtable/storage';
import type { ExecutionConfig, ServerConfig } from '../config.js';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, ForbiddenError } from './errors.js';
import { type StorageAlert, StorageAlertGate } from './storage-alerts.js';
import {
  type BuildCache,
  checkRoot,
  cleanupCandidates,
  directoryBytes,
  GiB,
  overlaps,
  prepareRoot,
  requireFree,
  resolveRoot,
  within,
} from './storage-files.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationBusyError, WorktreeMutationGuard } from './worktree-mutation-guard.js';

/** Host-owned placement and maintenance. Cleanup accepts controller previews, never browser paths. */
export class StorageService {
  private settings: StoredStorageSettings;
  private readonly dataIdentity: StorageRootIdentity;
  private scanResult: StorageStatus['scan'] = null;
  private candidates: BuildCache[] = [];
  private lastCleanup: StorageStatus['lastCleanup'] = null;
  private lastError: string | null = null;
  private operation: Promise<unknown> | undefined;
  private readonly runCleanups = new Map<WorktreeId, Promise<void>>();
  private stopping = false;
  private readonly alertGate = new StorageAlertGate();
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly executionConfig: ExecutionConfig;

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly config: ServerConfig,
    private readonly workspaces: WorkspaceService,
    private readonly now: () => Date = () => new Date(),
    private readonly mutations: WorktreeMutationGuard = new WorktreeMutationGuard(),
  ) {
    this.dataIdentity = {
      path: realpathSync(dirname(storage.databasePath)),
      device: statSync(storage.databasePath).dev,
    };
    const previous = storage.maintenance.settings();
    if (previous) {
      storagePolicySchema.parse(previous.policy);
      this.settings = previous;
    } else {
      const policy: StoragePolicy = {
        worktreeRoot: config.execution.worktreeRoot,
        runsRoot: config.execution.runsRoot,
        backupRoot: join(config.dataDir, 'backups'),
        autoCleanBuildCaches: true,
        scratchRetentionDays: 30,
        minimumFreeGiB: 5,
        dailyBackups: true,
        backupsToKeep: 7,
      };
      const roots = {
        worktreeRoot: prepareRoot(policy.worktreeRoot),
        runsRoot: prepareRoot(policy.runsRoot),
        backupRoot: prepareRoot(policy.backupRoot),
      };
      this.settings = { version: 1, policy, roots, mergeRoot: roots.worktreeRoot };
      storage.transaction((tx) => tx.maintenance.saveSettings(this.settings));
    }
    // Seed pre-feature runs once, without reinterpreting their paths on later settings changes.
    const legacyRoot = this.settings.roots.runsRoot;
    for (const run of storage.maintenance.unregisteredRuns()) {
      if (!/^[a-f0-9-]{36}$/.test(run.id)) continue;
      storage.maintenance.registerRunDirectory(
        run.id,
        join(legacyRoot.path, run.id),
        legacyRoot.device,
      );
    }
    const self = this;
    this.executionConfig = {
      ...config.execution,
      get worktreeRoot() {
        self.requireSpace('worktreeRoot');
        return self.settings.roots.worktreeRoot.path;
      },
      get runsRoot() {
        self.requireSpace('runsRoot');
        return self.settings.roots.runsRoot.path;
      },
      // Merge recovery has an existing path convention independent of future checkout placement.
      get mergeRoot() {
        try {
          checkRoot(self.settings.mergeRoot);
        } catch {
          throw new ExecutionRequestError(
            'unavailable',
            'The integration scratch volume is unavailable. Restore it before merging or recovering a merge.',
          );
        }
        return join(self.settings.mergeRoot.path, '.merge');
      },
    };
  }
  registerRun(runId: AgentRunId, directory: string): void {
    this.storage.maintenance.registerRunDirectory(
      runId,
      realpathSync(directory),
      statSync(directory).dev,
    );
  }
  requireSpace(kind: 'worktreeRoot' | 'runsRoot', extraPath?: string): void {
    const minimum = this.settings.policy.minimumFreeGiB * GiB;
    requireFree(this.dataIdentity, minimum);
    requireFree(this.settings.roots[kind], minimum);
    if (extraPath)
      requireFree({ path: realpathSync(extraPath), device: statSync(extraPath).dev }, minimum);
  }
  private authorize(context: AuthContext, workspaceId: WorkspaceId): void {
    this.workspaces.requireRole(context, workspaceId, ['owner']);
    if (!this.storage.maintenance.ownsInstallation(context.user.id)) throw new ForbiddenError();
  }
  get(context: AuthContext, workspaceId: WorkspaceId): StorageStatus {
    this.authorize(context, workspaceId);
    return this.status();
  }
  /** Notification sources: one coalesced, hysteresis-gated volume alert plus maintenance. */
  alerts(): readonly StorageAlert[] {
    const pressure = this.alertGate.evaluate(
      this.status().volumes.map((volume) => ({
        label: volume.label,
        path: volume.path,
        freeBytes: volume.realPath === null ? null : volume.freeBytes,
      })),
      this.settings.policy.minimumFreeGiB * GiB,
      this.now().getTime(),
    );
    if (this.lastError)
      pressure.push({
        key: 'storage:maintenance',
        message: `Storage maintenance needs attention: ${this.lastError}`,
      });
    return pressure;
  }
  private status(): StorageStatus {
    const locations = [
      { label: 'Database and history', root: this.dataIdentity },
      ...(['worktreeRoot', 'runsRoot', 'backupRoot'] as const).map((key) => ({
        label: {
          worktreeRoot: 'Future worktrees',
          runsRoot: 'Future run files',
          backupRoot: 'Database backups',
        }[key],
        root: this.settings.roots[key],
      })),
    ];
    if (!locations.some((location) => location.root.device === this.settings.mergeRoot.device))
      locations.push({ label: 'Integration scratch', root: this.settings.mergeRoot });
    const seen = new Set(locations.map((location) => location.root.device));
    for (const path of this.storage.maintenance.activeWorktreePaths()) {
      try {
        const root = { path: realpathSync(path), device: statSync(path).dev };
        if (!seen.has(root.device)) {
          locations.push({ label: `Existing worktree: ${path}`, root });
          seen.add(root.device);
        }
      } catch {
        /* Worktree recovery reports missing checkouts; capacity has no volume to inspect. */
      }
    }
    for (const run of this.storage.maintenance.directories().filter((run) => !run.eligible)) {
      if (!seen.has(run.device) && existsSync(run.path)) {
        locations.push({
          label: `Retained run files: ${dirname(run.path)}`,
          root: { path: run.path, device: run.device },
        });
        seen.add(run.device);
      }
    }
    return {
      version: this.settings.version,
      policy: this.settings.policy,
      volumes: locations.map(({ label, root }) => {
        try {
          checkRoot(root);
          const fs = statfsSync(root.path);
          return {
            label,
            path: root.path,
            realPath: realpathSync(root.path),
            freeBytes: fs.bavail * fs.bsize,
            totalBytes: fs.blocks * fs.bsize,
            error:
              fs.bavail * fs.bsize < this.settings.policy.minimumFreeGiB * GiB
                ? 'Below the free-space reserve. Reclaim space or change this location.'
                : null,
          };
        } catch {
          return {
            label,
            path: root.path,
            realPath: null,
            freeBytes: null,
            totalBytes: null,
            error: 'Volume unavailable or changed; restore the original mount.',
          };
        }
      }),
      scan: this.scanResult,
      backups: [...this.storage.maintenance.backups()],
      busy: this.operation !== undefined,
      lastError: this.lastError,
      lastCleanup: this.lastCleanup,
    };
  }
  save(context: AuthContext, workspaceId: WorkspaceId, input: SaveStorageRequest): StorageStatus {
    this.authorize(context, workspaceId);
    if (this.operation)
      throw new ExecutionRequestError('conflict', 'Wait for storage maintenance to finish.');
    if (input.expectedVersion !== this.settings.version)
      throw new ExecutionRequestError(
        'conflict',
        'Storage settings changed. Reload before saving.',
      );
    const policy = storagePolicySchema.parse(input.policy);
    if (
      policy.worktreeRoot !== this.settings.policy.worktreeRoot &&
      this.storage.execution.finalizations
        .list()
        .some(
          (value) =>
            !this.storage.execution.worktrees.find(value.workspaceId, value.worktreeId) &&
            value.status !== 'completed',
        )
    )
      throw new ExecutionRequestError(
        'conflict',
        'Recover the pending finalization worktree before changing its storage location.',
      );
    if (
      policy.worktreeRoot !== this.settings.policy.worktreeRoot &&
      this.storage.roadmaps
        .list()
        .some((roadmap) =>
          roadmap.attempts.some(
            (attempt) =>
              attempt.status === 'preparing' &&
              !this.storage.execution.worktrees.find(roadmap.workspaceId, attempt.worktreeId),
          ),
        )
    )
      throw new ExecutionRequestError(
        'conflict',
        'Recover pending roadmap worktree preparation before changing its storage location.',
      );
    const roots = { ...this.settings.roots };
    try {
      for (const key of ['worktreeRoot', 'runsRoot', 'backupRoot'] as const) {
        if (policy[key] === this.settings.policy[key]) {
          checkRoot(roots[key]);
          continue;
        }
        // Canonicalize the existing parent first; no recursive directory creation across a missing mount.
        roots[key] = resolveRoot(policy[key]);
      }
      const protectedPaths = [
        this.dataIdentity.path,
        ...this.storage.maintenance.protectedPaths(),
      ].map((path) => (existsSync(path) ? realpathSync(path) : path));
      const dataDir = realpathSync(this.config.dataDir);
      const activeTrees = new Set(
        this.storage.maintenance
          .activeWorktreePaths()
          .map((path) => (existsSync(path) ? realpathSync(path) : path)),
      );
      for (const key of ['worktreeRoot', 'runsRoot', 'backupRoot'] as const) {
        const path = roots[key].path;
        if (
          within(dataDir, path) ||
          protectedPaths.some(
            (other) =>
              overlaps(path, other) &&
              !(
                key === 'worktreeRoot' &&
                activeTrees.has(other) &&
                path === this.settings.roots.worktreeRoot.path &&
                within(other, path) &&
                !overlaps(other, this.dataIdentity.path)
              ),
          )
        )
          throw new ExecutionRequestError(
            'invalid-request',
            'Storage roots must not contain the database, source repositories, or existing worktrees.',
          );
        if (
          Object.entries(roots).some(
            ([otherKey, other]) => otherKey !== key && overlaps(path, other.path),
          )
        )
          throw new ExecutionRequestError(
            'invalid-request',
            'Worktree, run and backup locations must not overlap.',
          );
        if (key !== 'worktreeRoot' && overlaps(path, this.settings.mergeRoot.path))
          throw new ExecutionRequestError(
            'invalid-request',
            'This location overlaps the stable integration scratch root.',
          );
        // Retained runs keep their original locations, even after several settings changes.
        if (
          this.storage.maintenance
            .directories()
            .some((run) => (key === 'runsRoot' ? within(path, run.path) : overlaps(path, run.path)))
        )
          throw new ExecutionRequestError(
            'invalid-request',
            'This location overlaps retained run files.',
          );
        const existing = existsSync(path)
          ? roots[key]
          : { path: dirname(path), device: roots[key].device };
        if (policy[key] !== this.settings.policy[key])
          requireFree(existing, policy.minimumFreeGiB * GiB);
      }
    } catch (error) {
      if (error instanceof ExecutionRequestError) throw error;
      throw new ExecutionRequestError(
        'invalid-request',
        'Storage location is unavailable or not writable. Choose an existing directory or one new child of an existing directory.',
      );
    }
    for (const root of Object.values(roots)) prepareRoot(root.path);
    const next = {
      version: this.settings.version + 1,
      policy,
      roots,
      mergeRoot: this.settings.mergeRoot,
    };
    this.storage.transaction((tx) => {
      tx.maintenance.saveSettings(next);
      tx.audit.append({
        id: randomUUID(),
        occurredAt: this.now().toISOString(),
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        action: 'storage.updated',
        outcome: 'succeeded',
        priorVersion: this.settings.version,
        resultingVersion: next.version,
        metadata: { ...policy },
      });
    });
    this.settings = next;
    this.scanResult = null;
    this.candidates = [];
    return this.status();
  }
  private async exclusively<T>(job: () => Promise<T>): Promise<T> {
    if (this.operation)
      throw new ExecutionRequestError('conflict', 'Storage maintenance is already running.');
    const running = Promise.resolve().then(job);
    this.operation = running;
    try {
      const result = await running;
      this.lastError = null;
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Storage maintenance failed.';
      throw new ExecutionRequestError('unavailable', this.lastError);
    } finally {
      this.operation = undefined;
    }
  }
  async scan(context: AuthContext, workspaceId: WorkspaceId): Promise<StorageStatus> {
    this.authorize(context, workspaceId);
    await this.exclusively(() => this.scanUsage());
    return this.status();
  }
  private async scanUsage(): Promise<void> {
    const warnings: string[] = [];
    let runBytes = 0,
      worktreeBytes = 0;
    const directories = this.storage.maintenance.directories();
    const caches: BuildCache[] = [];
    for (const run of directories) {
      try {
        if (!existsSync(run.path)) continue;
        checkRoot({ path: run.path, device: run.device });
        runBytes += await directoryBytes(run.path, run.device);
        if (run.eligible || run.buildEligible)
          caches.push(
            ...(await cleanupCandidates(
              run,
              run.eligible ? this.settings.policy.scratchRetentionDays : 0,
              this.now(),
            )),
          );
      } catch {
        warnings.push(`Could not fully inspect run ${run.runId}; its files are retained.`);
      }
    }
    for (const path of this.storage.maintenance.activeWorktreePaths()) {
      try {
        worktreeBytes += await directoryBytes(realpathSync(path));
      } catch {
        warnings.push(`Could not fully inspect worktree ${path}.`);
      }
    }
    caches.push(...(await this.worktreeCacheCandidates()));
    for (const cache of this.storage.maintenance.worktreeCaches())
      if (existsSync(cache.path)) runBytes += await directoryBytes(cache.path, cache.device);
    this.candidates = caches;
    this.scanResult = {
      id: randomUUID(),
      completedAt: this.now().toISOString(),
      worktreeBytes,
      runBytes,
      reclaimableBytes: caches.reduce((sum, cache) => sum + cache.bytes, 0),
      cacheCount: caches.filter((cache) => cache.kind === 'build').length,
      expiredScratchCount: caches.filter((cache) => cache.kind === 'scratch').length,
      protectedRuns: directories.filter((run) => !run.eligible && !run.buildEligible).length,
      warnings,
    };
  }
  async clean(
    context: AuthContext,
    workspaceId: WorkspaceId,
    scanId: string,
  ): Promise<StorageStatus> {
    this.authorize(context, workspaceId);
    if (this.scanResult?.id !== scanId)
      throw new ExecutionRequestError('conflict', 'Scan storage again before cleaning.');
    await this.exclusively(() => this.cleanCaches(context, workspaceId));
    return this.status();
  }
  private async cleanCaches(context?: AuthContext, workspaceId?: WorkspaceId): Promise<void> {
    let count = 0,
      bytes = 0;
    const candidates = this.candidates;
    this.candidates = [];
    this.scanResult = null;
    for (const candidate of candidates) {
      if (candidate.worktreeId) {
        if (await this.removeWorktreeCache(candidate, context, workspaceId)) {
          count++;
          bytes += candidate.bytes;
        }
        continue;
      }
      const run = this.storage.maintenance
        .directories()
        .find(
          (value) =>
            value.runId === candidate.runId &&
            (candidate.kind === 'build' ? value.buildEligible : value.eligible),
        );
      if (!run) continue;
      const remove = async () => {
        const fresh = (
          await cleanupCandidates(
            run,
            run.eligible ? this.settings.policy.scratchRetentionDays : 0,
            this.now(),
          )
        ).find(
          (cache) =>
            cache.path === candidate.path &&
            cache.inode === candidate.inode &&
            cache.device === candidate.device,
        );
        if (!fresh) return;
        const current = this.storage.maintenance
          .directories()
          .find((value) => value.runId === run.runId);
        if (
          !(candidate.kind === 'build' ? current?.buildEligible : current?.eligible) ||
          current?.path !== run.path ||
          current.device !== run.device
        )
          return;
        checkRoot({ path: run.path, device: run.device });
        const identity = lstatSync(fresh.path);
        if (
          realpathSync(fresh.path) !== fresh.path ||
          identity.ino !== fresh.inode ||
          identity.dev !== fresh.device
        )
          return;
        // Intent is durable before deletion. Only the controller's eligible scratch list grants authority.
        this.storage.audit.append({
          id: randomUUID(),
          occurredAt: this.now().toISOString(),
          actorKind: context ? 'user' : 'system',
          ...(context ? { actorUserId: context.user.id, sessionId: context.session.id } : {}),
          workspaceId: workspaceId ?? run.workspaceId,
          action: 'storage.cleaned',
          outcome: 'succeeded',
          metadata: { phase: 'authorized', runId: run.runId, path: fresh.path, bytes: fresh.bytes },
        });
        try {
          await rm(fresh.path, { recursive: true });
        } catch (error) {
          this.storage.audit.append({
            id: randomUUID(),
            occurredAt: this.now().toISOString(),
            actorKind: 'system',
            workspaceId: run.workspaceId,
            action: 'storage.cleaned',
            outcome: 'failed',
            metadata: { phase: 'removal', runId: run.runId, path: fresh.path },
          });
          throw error;
        }
        this.storage.audit.append({
          id: randomUUID(),
          occurredAt: this.now().toISOString(),
          actorKind: 'system',
          workspaceId: run.workspaceId,
          action: 'storage.cleaned',
          outcome: 'succeeded',
          metadata: { phase: 'removed', runId: run.runId, path: fresh.path, bytes: fresh.bytes },
        });
        count++;
        bytes += fresh.bytes;
        this.lastCleanup = { completedAt: this.now().toISOString(), cachesRemoved: count, bytes };
      };
      try {
        await this.mutations.during(run.worktreeId, remove);
      } catch (error) {
        if (!(error instanceof WorktreeMutationBusyError)) throw error;
      }
    }
    this.lastCleanup = { completedAt: this.now().toISOString(), cachesRemoved: count, bytes };
  }
  /**
   * Shared worktree build caches (R-G7) that cleanup may remove: the worktree is merged or
   * removed and nothing runs in it. A registration whose directory is already gone is
   * forgotten; a directory whose identity changed (a link, another device) is left alone.
   */
  private async worktreeCacheCandidates(): Promise<BuildCache[]> {
    const found: BuildCache[] = [];
    for (const cache of this.storage.maintenance.worktreeCaches()) {
      if (!cache.eligible) continue;
      if (!existsSync(cache.path)) {
        this.storage.maintenance.forgetWorktreeCache(cache.worktreeId);
        continue;
      }
      const entry = await lstat(cache.path);
      if (
        !entry.isDirectory() ||
        entry.dev !== cache.device ||
        realpathSync(cache.path) !== cache.path
      )
        continue;
      found.push({
        kind: 'build',
        path: cache.path,
        runId: '',
        worktreeId: cache.worktreeId,
        device: entry.dev,
        inode: entry.ino,
        bytes: await directoryBytes(cache.path, cache.device),
      });
    }
    return found;
  }

  /** Removes one shared worktree cache under the worktree's mutation guard, audited like run caches. */
  private async removeWorktreeCache(
    candidate: BuildCache,
    context?: AuthContext,
    workspaceId?: WorkspaceId,
  ): Promise<boolean> {
    const worktreeId = candidate.worktreeId;
    if (!worktreeId) return false;
    let removed = false;
    const remove = async () => {
      const current = this.storage.maintenance
        .worktreeCaches()
        .find((cache) => cache.worktreeId === worktreeId);
      if (!current?.eligible || current.path !== candidate.path) return;
      const identity = lstatSync(candidate.path);
      if (
        realpathSync(candidate.path) !== candidate.path ||
        identity.ino !== candidate.inode ||
        identity.dev !== candidate.device
      )
        return;
      const metadata = { worktreeId, path: candidate.path, bytes: candidate.bytes };
      this.storage.audit.append({
        id: randomUUID(),
        occurredAt: this.now().toISOString(),
        actorKind: context ? 'user' : 'system',
        ...(context ? { actorUserId: context.user.id, sessionId: context.session.id } : {}),
        workspaceId: workspaceId ?? current.workspaceId,
        action: 'storage.cleaned',
        outcome: 'succeeded',
        metadata: { phase: 'authorized', ...metadata },
      });
      try {
        await rm(candidate.path, { recursive: true });
      } catch (error) {
        this.storage.audit.append({
          id: randomUUID(),
          occurredAt: this.now().toISOString(),
          actorKind: 'system',
          workspaceId: current.workspaceId,
          action: 'storage.cleaned',
          outcome: 'failed',
          metadata: { phase: 'removal', worktreeId, path: candidate.path },
        });
        throw error;
      }
      this.storage.transaction((tx) => {
        tx.maintenance.forgetWorktreeCache(worktreeId);
        tx.audit.append({
          id: randomUUID(),
          occurredAt: this.now().toISOString(),
          actorKind: 'system',
          workspaceId: current.workspaceId,
          action: 'storage.cleaned',
          outcome: 'succeeded',
          metadata: { phase: 'removed', ...metadata },
        });
      });
      removed = true;
    };
    try {
      await this.mutations.during(worktreeId, remove);
    } catch (error) {
      if (!(error instanceof WorktreeMutationBusyError)) throw error;
    }
    return removed;
  }

  async backup(context: AuthContext, workspaceId: WorkspaceId): Promise<StorageStatus> {
    this.authorize(context, workspaceId);
    await this.exclusively(() => this.writeBackup(context, workspaceId));
    return this.status();
  }
  private async writeBackup(context?: AuthContext, workspaceId?: WorkspaceId): Promise<void> {
    const root = this.settings.roots.backupRoot;
    requireFree(root, Math.max(statSync(this.storage.databasePath).size * 2, GiB));
    const directory = join(root.path, 'database');
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    if (
      lstatSync(directory).isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      statSync(directory).dev !== root.device
    )
      throw new Error('Backup directory identity changed.');
    chmodSync(directory, 0o700);
    const createdAt = this.now().toISOString();
    const destination = join(
      directory,
      `craftingtable-${createdAt.replaceAll(':', '-')}-${randomUUID()}.sqlite`,
    );
    const partial = `${destination}.partial`;
    writeFileSync(partial, '', { mode: 0o600, flag: 'wx' });
    try {
      await this.storage.backup(partial);
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    const bytes = (await stat(destination)).size;
    this.storage.transaction((tx) => {
      tx.maintenance.saveBackup({ path: destination, createdAt, bytes });
      tx.audit.append({
        id: randomUUID(),
        occurredAt: createdAt,
        actorKind: context ? 'user' : 'system',
        ...(context ? { actorUserId: context.user.id, sessionId: context.session.id } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        action: 'storage.backup',
        outcome: 'succeeded',
        metadata: { path: destination, bytes },
      });
    });
    // Only this feature's registered backups on the current volume are subject to retention.
    const backups = this.storage.maintenance
      .backups()
      .filter((value) => dirname(value.path) === directory);
    for (const expired of backups.slice(this.settings.policy.backupsToKeep)) {
      checkRoot(root);
      if (
        existsSync(expired.path) &&
        (lstatSync(expired.path).isSymbolicLink() || !lstatSync(expired.path).isFile())
      )
        continue;
      await rm(expired.path, { force: true });
      this.storage.maintenance.forgetBackup(expired.path);
    }
  }
  isCleaningRun(worktreeId: WorktreeId): boolean {
    return this.runCleanups.has(worktreeId);
  }
  async waitForRunCleanup(worktreeId: WorktreeId): Promise<void> {
    await this.runCleanups.get(worktreeId);
  }
  /** Runs after process-group exit; automation waits before reserving the next step. */
  cleanupAfterRun(worktreeId: WorktreeId): Promise<void> {
    const existing = this.runCleanups.get(worktreeId);
    if (existing) return existing;
    if (this.stopping || !this.settings.policy.autoCleanBuildCaches) return Promise.resolve();
    const pending = (async () => {
      while (this.operation) await this.operation.catch(() => undefined);
      if (this.stopping || !this.settings.policy.autoCleanBuildCaches) return;
      await this.exclusively(async () => {
        const candidates: BuildCache[] = [];
        for (const run of this.storage.maintenance
          .directories()
          .filter((r) => r.worktreeId === worktreeId && r.buildEligible))
          candidates.push(...(await cleanupCandidates(run, 0, this.now())));
        if (!candidates.length) return;
        this.candidates = candidates;
        await this.cleanCaches();
      });
    })()
      .catch(() => {
        // Periodic maintenance retries failures; the recorded outcome remains authoritative.
      })
      .finally(() => {
        this.runCleanups.delete(worktreeId);
      });
    this.runCleanups.set(worktreeId, pending);
    return pending;
  }
  startWorker(): void {
    this.stopping = false;
    if (this.timer) return;
    // Stagger maintenance away from recovery and initial requests; retry failures on the next tick.
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 60_000);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.operation) return;
    await this.exclusively(async () => {
      const failures: string[] = [];
      try {
        if (
          this.settings.policy.autoCleanBuildCaches ||
          this.settings.policy.scratchRetentionDays
        ) {
          const candidates: BuildCache[] = [];
          for (const run of this.storage.maintenance
            .directories()
            .filter((value) => value.eligible || value.buildEligible)) {
            try {
              candidates.push(
                ...(await cleanupCandidates(
                  run,
                  run.eligible ? this.settings.policy.scratchRetentionDays : 0,
                  this.now(),
                )),
              );
            } catch {
              failures.push(`Could not inspect eligible scratch for run ${run.runId}; retained.`);
            }
          }
          if (this.settings.policy.autoCleanBuildCaches)
            candidates.push(...(await this.worktreeCacheCandidates()));
          const eligible = candidates.filter(
            (candidate) =>
              candidate.kind === 'scratch' || this.settings.policy.autoCleanBuildCaches,
          );
          if (eligible.length) {
            this.candidates = eligible;
            await this.cleanCaches();
          }
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Cleanup failed.');
      }
      // A bad cache must not starve backups, and a full backup disk must not stop reclamation.
      try {
        const newest = this.storage.maintenance
          .backups()
          .find((value) => within(value.path, this.settings.roots.backupRoot.path));
        if (
          this.settings.policy.dailyBackups &&
          (!newest || this.now().getTime() - Date.parse(newest.createdAt) >= 86_400_000)
        )
          await this.writeBackup();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Backup failed.');
      }
      if (failures.length) throw new Error(failures.join(' '));
    });
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.operation?.catch(() => undefined);
    await Promise.allSettled(this.runCleanups.values());
  }
}
