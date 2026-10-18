/**
 * A launch's reservation (R-B7 decision 1, AGT-12): the launch's durable record before its first
 * file, naming the run directory and the check-reply directory it will make. A launch refused
 * before its run row commits removes what it made, then the reservation; a start clears the
 * reservations a stop cut short, and once, the run directories refused launches left before this
 * release.
 */
import { lstatSync, readdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AgentRunId } from '@craftingtable/domain';
import type { CraftingTableStorage, RunLaunchReservation } from '@craftingtable/storage';
import { removeAgentTree } from '../agent-tree.js';
import type { RunLog } from './shared.js';

/** A run's id, as the run directories in the runs root are named. */
const RUN_DIRECTORY_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How many removed or kept directories a start's one warning names. */
const DIRECTORIES_NAMED = 20;

/** The device of the directory a path is, or would be, made on: its nearest existing ancestor's. */
export function deviceOf(path: string): number {
  for (let at = path; ; at = dirname(at)) {
    try {
      return statSync(at).dev;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw error;
    }
  }
}

/**
 * Removes a directory a launch made, only as the reservation named it: a directory, not a link,
 * on the device recorded. Returns why it was not removed, or nothing once it is gone.
 */
export async function removeReservedDirectory(
  path: string,
  device: number,
): Promise<string | undefined> {
  let found: ReturnType<typeof lstatSync> | undefined;
  try {
    found = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    return String(error);
  }
  if (found === undefined) return undefined;
  if (!found.isDirectory()) return `${path} is not a directory`;
  if (found.dev !== device) return `${path} is on another device than the one reserved`;
  return removeAgentTree(path);
}

/**
 * Removes what a reservation names (the run directory, the check-reply directory and the run's
 * check-log directory if that leaves it empty), then the reservation; a directory that cannot be
 * removed keeps the reservation, so the next start tries again. Returns whether it went.
 */
export async function removeReservation(
  storage: CraftingTableStorage,
  log: RunLog,
  reservation: RunLaunchReservation,
): Promise<boolean> {
  const failures: string[] = [];
  // Only what a reservation of this run can name: `<root>/<run id>` and `<root>/<run id>/replies`
  // (increment 11b review, LOW-2; the table's checks hold the same).
  if (
    basename(reservation.runDirectory) !== reservation.runId ||
    !reservation.replyDirectory.endsWith(`/${reservation.runId}/replies`)
  )
    failures.push(`the reservation names directories that are not run ${reservation.runId}'s`);
  else
    for (const [path, device] of [
      [reservation.runDirectory, reservation.runDevice],
      [reservation.replyDirectory, reservation.replyDevice],
    ] as const) {
      const failure = await removeReservedDirectory(path, device);
      if (failure !== undefined) failures.push(failure);
    }
  if (failures.length === 0)
    try {
      rmdirSync(dirname(reservation.replyDirectory));
    } catch {
      /* not empty, or already gone: the run's check logs stay */
    }
  if (failures.length > 0) {
    log.warn("A refused launch's directories could not be removed; the next start tries again", {
      runId: reservation.runId,
      errors: failures.join('; '),
    });
    return false;
  }
  storage.transaction((tx) => tx.maintenance.dropLaunch(reservation.runId));
  return true;
}

/**
 * At start, before any launch: a reservation whose run row exists is the run's now (storage has
 * registered its directory), and is dropped; one with none was a launch a stop cut short, and
 * goes with what it made.
 */
export async function clearReservations(
  storage: CraftingTableStorage,
  log: RunLog,
  runExists: (reservation: RunLaunchReservation) => boolean,
): Promise<void> {
  for (const reservation of storage.maintenance.launchReservations()) {
    if (runExists(reservation))
      storage.transaction((tx) => tx.maintenance.dropLaunch(reservation.runId));
    else await removeReservation(storage, log, reservation);
  }
}

/**
 * The one-time start-up task migration 0046 asks for: removes the run directories in the runs
 * root that no run row, directory row or reservation owns, which refused launches left before
 * this release (AGT-12's orphans). Only directories named as a run's id, on the root's device,
 * never through a link; the task is done once every one of them is gone.
 */
export async function removeOrphanRunDirectories(
  storage: CraftingTableStorage,
  log: RunLog,
  runsRoot: string,
): Promise<void> {
  if (!storage.maintenance.startupTaskPending('remove-orphan-run-directories')) return;
  let names: string[];
  let device: number;
  try {
    device = statSync(runsRoot).dev;
    names = readdirSync(runsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('The runs root could not be read for directories no run owns', {
        root: runsRoot,
        error: String(error),
      });
      return;
    }
    names = [];
    device = 0;
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of names.sort()) {
    if (!RUN_DIRECTORY_NAME.test(name)) continue;
    const path = join(runsRoot, name);
    let real: string;
    try {
      const found = lstatSync(path);
      if (!found.isDirectory() || found.dev !== device) continue;
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (storage.maintenance.ownsRunDirectory(name as AgentRunId, real)) continue;
    const failure = await removeAgentTree(path);
    if (failure === undefined) removed.push(name);
    else kept.push(`${name}: ${failure}`);
  }
  if (removed.length > 0)
    log.warn('Removed run directories no run owned, left by refused launches (AGT-12)', {
      root: runsRoot,
      count: removed.length,
      directories: removed.slice(0, DIRECTORIES_NAMED),
    });
  if (kept.length > 0) {
    log.warn('Run directories no run owns could not be removed; the next start tries again', {
      root: runsRoot,
      count: kept.length,
      errors: kept.slice(0, DIRECTORIES_NAMED),
    });
    return;
  }
  storage.transaction((tx) => tx.maintenance.completeStartupTask('remove-orphan-run-directories'));
}
