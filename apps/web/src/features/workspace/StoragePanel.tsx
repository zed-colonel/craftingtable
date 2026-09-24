import type { StorageStatus } from '@craftingtable/contracts';
import type { StoragePolicy, WorkspaceId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { loadStorage, saveStorage, storageCommand } from '../../lib/storage-api.js';
import { distinct } from '../../lib/distinct.js';

const size = (bytes: number | null) =>
  bytes === null
    ? 'Unavailable'
    : bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
export function StoragePanel({
  workspaceId,
  csrfToken,
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
}) {
  const [status, setStatus] = useState<StorageStatus>();
  const [draft, setDraft] = useState<StoragePolicy>();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    let alive = true;
    void loadStorage(workspaceId)
      .then((value) => {
        if (alive) {
          setStatus(value);
          setDraft(value.policy);
          setVersion(value.version);
        }
      })
      .catch((value) => {
        if (alive)
          setError(value instanceof Error ? value.message : 'Could not load storage settings.');
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  const act = async (action: 'save' | 'scan' | 'clean' | 'backup' | 'reload') => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const value =
        action === 'reload'
          ? await loadStorage(workspaceId)
          : action === 'save' && draft
            ? await saveStorage(workspaceId, { expectedVersion: version, policy: draft }, csrfToken)
            : await storageCommand(
                workspaceId,
                action as 'scan' | 'clean' | 'backup',
                csrfToken,
                action === 'clean' ? status?.scan?.id : undefined,
              );
      setStatus(value);
      if (action === 'save' || action === 'reload') {
        setDraft(value.policy);
        setVersion(value.version);
      }
      setNotice(
        {
          save: 'Storage settings saved. Future work uses these locations; existing files stay where they are.',
          scan: 'Storage scan complete. Review the reclaimable space below.',
          clean: 'Eligible files cleaned. Run a new scan to refresh usage.',
          backup: 'Consistent database backup created.',
          reload: 'Storage settings reloaded.',
        }[action],
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Storage operation failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel storage-panel" aria-label="Storage">
      <h3>Storage</h3>
      <p className="hint">
        These settings apply to the whole installation. Only an owner of every active workspace can
        change them.
      </p>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="success-state">
          {notice}
        </p>
      )}
      {status && draft ? (
        <>
          <div className="storage-volumes">
            {status.volumes.map((volume) => (
              <div className="storage-volume" key={volume.label}>
                <strong>{volume.label}</strong>
                <span className="mono storage-path">{volume.realPath ?? volume.path}</span>
                <span>
                  {size(volume.freeBytes)} free of {size(volume.totalBytes)}
                </span>
                {volume.error && (
                  <span role="alert" className="error-state">
                    {volume.error}
                  </span>
                )}
              </div>
            ))}
          </div>
          <details>
            <summary>Locations and retention</summary>
            <form
              className="stack-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act('save');
              }}
            >
              <p className="hint">
                Locations are directories on the workstation. Select an existing directory or a new
                child of an existing directory. Changing a location affects future work; it does not
                relocate existing worktrees or run files.
              </p>
              {(['worktreeRoot', 'runsRoot', 'backupRoot'] as const).map((key) => (
                <label className="field" key={key}>
                  {
                    {
                      worktreeRoot: 'Worktree location',
                      runsRoot: 'Run files and scratch location',
                      backupRoot: 'Backup location',
                    }[key]
                  }
                  <input
                    required
                    value={draft[key]}
                    disabled={busy}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </label>
              ))}
              <p className="hint">
                Database and history move together while the daemon is stopped. The displayed
                database path is its actual disk location, including any compatibility link.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={draft.autoCleanBuildCaches}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, autoCleanBuildCaches: event.target.checked })
                  }
                />{' '}
                Automatically clean recognized Cargo build caches after each run ends
              </label>
              <label className="field">
                Other scratch files
                <select
                  value={draft.scratchRetentionDays}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      scratchRetentionDays: Number(event.target.value) as 0 | 30,
                    })
                  }
                >
                  <option value={30}>Expire after 30 days</option>
                  <option value={0}>Keep until manually removed</option>
                </select>
              </label>
              <p className="hint">
                Other scratch expiry starts after merge and worktree removal, and recent file
                changes extend it. Active and interrupted work stays protected. Run messages,
                findings, and verification recorded in history are retained; scratch files
                themselves are disposable.
              </p>
              <label className="field">
                Minimum free space (GiB)
                <input
                  type="number"
                  min={1}
                  max={1024}
                  required
                  value={draft.minimumFreeGiB}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, minimumFreeGiB: Number(event.target.value) })
                  }
                />
              </label>
              <p className="hint">
                New runs and worktrees stop below this reserve. This is a launch check, not a quota
                on a running build. Storage pressure also uses your existing attention
                notifications.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={draft.dailyBackups}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, dailyBackups: event.target.checked })}
                />{' '}
                Create a database backup every 24 hours
              </label>
              <label className="field">
                Database backups to keep
                <input
                  type="number"
                  min={1}
                  max={30}
                  required
                  value={draft.backupsToKeep}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, backupsToKeep: Number(event.target.value) })
                  }
                />
              </label>
              <button type="submit" className="primary-button" disabled={busy}>
                Save storage settings
              </button>
            </form>
          </details>
          <h4>Usage and cleanup</h4>
          <p className="hint">
            Scan before cleanup. Only recognized build caches and expired scratch from merged,
            removed worktrees are eligible. Source files, Git data, run messages, findings and plan
            documents are preserved.
          </p>
          {status.scan && (
            <>
              <dl className="definition-grid">
                <dt>Worktrees</dt>
                <dd>{size(status.scan.worktreeBytes)}</dd>
                <dt>Run files and scratch</dt>
                <dd>{size(status.scan.runBytes)}</dd>
                <dt>Reclaimable</dt>
                <dd>
                  {size(status.scan.reclaimableBytes)} · {status.scan.cacheCount} build caches ·{' '}
                  {status.scan.expiredScratchCount} expired scratch directories
                </dd>
                <dt>Protected runs</dt>
                <dd>{status.scan.protectedRuns}</dd>
              </dl>
              <p className="hint">
                Scanned {new Date(status.scan.completedAt).toLocaleString()}. Sizes count allocated
                file blocks; compressed or shared files can differ from physical disk usage.
              </p>
              {distinct(status.scan.warnings).map((warning) => (
                <p className="hint" key={warning}>
                  {warning}
                </p>
              ))}
            </>
          )}
          {status.lastCleanup && (
            <p className="hint">
              Last cleanup: {size(status.lastCleanup.bytes)} across{' '}
              {status.lastCleanup.cachesRemoved} directories.
            </p>
          )}
          <div className="inline-actions">
            <button type="button" disabled={busy} onClick={() => void act('scan')}>
              {busy ? 'Working…' : 'Scan storage'}
            </button>
            <button
              type="button"
              disabled={
                busy ||
                !status.scan ||
                status.scan.cacheCount + status.scan.expiredScratchCount === 0
              }
              onClick={() => void act('clean')}
            >
              Clean eligible files
            </button>
          </div>
          <h4>Backups</h4>
          <p className="hint">
            Private SQLite snapshots include plans, run history, settings and credentials. They do
            not include repositories or working files. Use a different disk for protection against
            drive failure, and back up source repositories separately.
          </p>
          <div className="inline-actions">
            <button type="button" disabled={busy} onClick={() => void act('backup')}>
              Back up database now
            </button>
          </div>
          {status.backups.length ? (
            <details>
              <summary>{status.backups.length} recorded database backups</summary>
              <ul>
                {status.backups.map((backup) => (
                  <li key={backup.path}>
                    {new Date(backup.createdAt).toLocaleString()} · {size(backup.bytes)}
                    <br />
                    <span className="mono storage-path">{backup.path}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="hint">No database backups recorded yet.</p>
          )}
          {status.lastError && (
            <p role="alert" className="error-state">
              Last maintenance error: {status.lastError}
            </p>
          )}
        </>
      ) : (
        !error && <p>Loading storage settings…</p>
      )}
      <button type="button" disabled={busy} onClick={() => void act('reload')}>
        Reload storage settings
      </button>
    </section>
  );
}
