import { GiB } from './storage-files.js';

/** Free space must exceed the reserve by this much (or 10% of the reserve) before an alert clears. */
export const STORAGE_ALERT_CLEAR_MARGIN_BYTES = 2 * GiB;
/** A raised volume clears only after staying above reserve + margin for this long. */
export const STORAGE_ALERT_CLEAR_HOLD_MS = 5 * 60_000;
/** A mount must stay unavailable this long before it raises; brief remounts stay quiet. */
export const STORAGE_UNAVAILABLE_GRACE_MS = 90_000;

export interface StorageVolumeReading {
  readonly label: string;
  readonly path: string;
  /** `null` when the volume is unavailable or changed identity. */
  readonly freeBytes: number | null;
}
export interface StorageAlert {
  readonly key: string;
  readonly message: string;
  /** Set-valued alerts re-page only when a member is added. */
  readonly members?: readonly string[];
}
interface VolumeState {
  raised?: 'low' | 'unavailable';
  unavailableSince?: number;
  healthySince?: number;
}
const REASON = {
  low: 'Below the free-space reserve. Reclaim space or change this location.',
  unavailable: 'Volume unavailable or changed; restore the original mount.',
} as const;

/**
 * Hysteresis for capacity alerts (NOTIF-05). A volume raises as soon as it drops below the
 * reserve, or after a mount stays unavailable through a grace period. It clears only after it
 * stays comfortably above the reserve for a hold period, so a volume hovering at the threshold
 * produces one alert instead of a burst. All raised volumes share one coalesced alert.
 */
export class StorageAlertGate {
  private readonly volumes = new Map<string, VolumeState>();
  evaluate(
    readings: readonly StorageVolumeReading[],
    reserveBytes: number,
    now: number,
  ): StorageAlert[] {
    const clearAbove = reserveBytes + Math.max(STORAGE_ALERT_CLEAR_MARGIN_BYTES, reserveBytes / 10);
    for (const path of this.volumes.keys())
      if (!readings.some((reading) => reading.path === path)) this.volumes.delete(path);
    const raised: { label: string; path: string; reason: string }[] = [];
    for (const reading of readings) {
      const state = this.volumes.get(reading.path) ?? {};
      if (reading.freeBytes === null) {
        state.healthySince = undefined;
        state.unavailableSince ??= now;
        if (state.raised || now - state.unavailableSince >= STORAGE_UNAVAILABLE_GRACE_MS)
          state.raised = 'unavailable';
      } else {
        state.unavailableSince = undefined;
        if (reading.freeBytes < reserveBytes) {
          state.raised = 'low';
          state.healthySince = undefined;
        } else if (state.raised && reading.freeBytes >= clearAbove) {
          state.healthySince ??= now;
          if (now - state.healthySince >= STORAGE_ALERT_CLEAR_HOLD_MS) {
            state.raised = undefined;
            state.healthySince = undefined;
          }
        } else state.healthySince = undefined;
      }
      this.volumes.set(reading.path, state);
      if (state.raised)
        raised.push({ label: reading.label, path: reading.path, reason: REASON[state.raised] });
    }
    return raised.length
      ? [
          {
            key: 'storage:volumes',
            message: `${raised.map((volume) => `${volume.label}: ${volume.reason}`).join('\n')}\nOpen Storage settings to inspect disk capacity and cleanup options.`,
            members: raised.map((volume) => volume.path).sort(),
          },
        ]
      : [];
  }
}
