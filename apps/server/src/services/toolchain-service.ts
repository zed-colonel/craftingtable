import {
  observeToolchain,
  type PythonToolchain,
  type ToolchainSettings,
  type ToolIdentity,
  type ToolObservation,
} from '@craftingtable/agents';
import type { ToolchainTool, ToolProblemCode } from '@craftingtable/domain';
import type { RunLog } from './run/shared.js';

/** How many changes Tools keeps per tool. */
const CHANGES_KEPT = 20;

/** One tool as Tools shows it (R-G17 decisions 4 and 5). */
export interface ToolStatus {
  readonly tool: ToolchainTool;
  readonly path: string;
  readonly configuredVersion?: string;
  readonly identity?: ToolIdentity;
  readonly problem?: { readonly code: ToolProblemCode; readonly message: string };
  /** When the daemon last read it: at start, or a Python check's re-read. */
  readonly checkedAt?: string;
  /** What changed and when since the daemon started, oldest first, at most 20. */
  readonly changes: readonly { readonly at: string; readonly from: string; readonly to: string }[];
}

export interface ToolchainStatus {
  readonly limits: ToolchainSettings['limits'];
  readonly python?: PythonToolchain;
  readonly tools: readonly ToolStatus[];
}

/** The paths the profile names, by tool. */
function profilePaths(profile: PythonToolchain | undefined): Map<ToolchainTool, readonly string[]> {
  if (!profile) return new Map();
  const media = profile.media ?? {};
  return new Map<ToolchainTool, readonly string[]>([
    ['python', [profile.interpreter]],
    ['uv', [profile.uv.path]],
    ...(media.ffmpeg ? [['ffmpeg', [media.ffmpeg]] as const] : []),
    ...(media.ffprobe ? [['ffprobe', [media.ffprobe]] as const] : []),
    ...(media.fonts?.length ? [['font', media.fonts] as const] : []),
  ]);
}

/** The version the profile configures, by tool: Python's and uv's; none for media. */
function configuredVersions(profile: PythonToolchain | undefined): Map<ToolchainTool, string> {
  return profile
    ? new Map<ToolchainTool, string>([
        ['python', profile.version],
        ['uv', profile.uv.version],
      ])
    : new Map();
}

/** A tool's state in a few words, to say what changed. */
function describe(observation: ToolObservation): string {
  if (observation.problem && !observation.identity)
    return `refused: ${observation.problem.message}`.slice(0, 300);
  const identity = observation.identity as ToolIdentity;
  const text = `version ${identity.version ?? 'unknown'}, sha256 ${identity.sha256.slice(0, 12)}…, owner ${identity.uid}, mode ${identity.mode}`;
  return (observation.problem ? `${text}; refused: ${observation.problem.message}` : text).slice(
    0,
    300,
  );
}

/**
 * The configured toolchain's identities (R-G17 decisions 4 and 5): the fixed probes at start,
 * and every Python check's re-read after. A change is recorded, with when the daemon saw it;
 * checks are refused only by the rule and the configured versions, which each check applies
 * itself. The changes are kept in memory since the start: each check's receipt holds the
 * identities it ran with, which is the lasting record.
 */
export class ToolchainService {
  private readonly tools = new Map<string, ToolStatus>();

  constructor(
    private readonly settings: ToolchainSettings,
    private readonly observe: (profile: PythonToolchain) => Promise<ToolObservation[]> = (
      profile,
    ) => observeToolchain(profile),
    private readonly now: () => Date = () => new Date(),
    private readonly log: Pick<RunLog, 'warn'> = { warn: () => undefined },
  ) {}

  /** Probes the profile's tools now; never fails, so the start does not wait on it. */
  async refresh(): Promise<void> {
    const python = this.settings.python;
    if (!python) return;
    try {
      this.record(await this.observe(python));
    } catch (error) {
      this.log.warn('The configured toolchain could not be probed', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Records what a probe or a check found, and what changed since the last look. Only the current
   * profile's tools: a check of a run launched before a restart re-reads the profile in its own
   * manifest, which may name other paths (review L-7).
   */
  record(observations: readonly ToolObservation[]): void {
    const at = this.now().toISOString();
    const configured = profilePaths(this.settings.python);
    const versions = configuredVersions(this.settings.python);
    for (const observation of observations) {
      if (configured.get(observation.tool)?.includes(observation.path) !== true) continue;
      // The same path under another configured version is an older profile's (re-check N-6).
      if (observation.configuredVersion !== versions.get(observation.tool)) continue;
      const key = `${observation.tool}\0${observation.path}`;
      const previous = this.tools.get(key);
      const to = describe(observation);
      const changes = [...(previous?.changes ?? [])];
      if (previous) {
        const from = describe(previous as ToolObservation);
        if (from !== to) changes.push({ at, from, to });
      }
      this.tools.set(key, {
        tool: observation.tool,
        path: observation.path,
        ...(observation.configuredVersion === undefined
          ? {}
          : { configuredVersion: observation.configuredVersion }),
        ...(observation.identity ? { identity: observation.identity } : {}),
        ...(observation.problem ? { problem: observation.problem } : {}),
        checkedAt: at,
        changes: changes.slice(-CHANGES_KEPT),
      });
    }
  }

  status(): ToolchainStatus {
    return {
      limits: this.settings.limits,
      ...(this.settings.python ? { python: this.settings.python } : {}),
      tools: [...this.tools.values()],
    };
  }
}
