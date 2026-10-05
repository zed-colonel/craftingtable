import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AgentModel } from '@craftingtable/domain';
import { isRecord } from '../bounded.js';
import { spawnSupervisedProcess } from '../process.js';
import {
  MODEL_ID,
  MODEL_SECTION,
  ModelCatalogError,
  type ModelDiscovery,
  modelLabel,
} from '../model-catalog.js';
import { CLAUDE_CODE_ALIASES } from './models.js';

/**
 * Claude Code's per-account model catalog (R-G15), an undocumented file the CLI caches under
 * `<config>/cache/model-catalog/<account>-cc.json`. Only this format version is read: any other
 * is reported as unsupported and the built-in list stays in use.
 */
export const CLAUDE_CATALOG_VERSION = 2;

const CATALOG_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}-cc\.json$/;
const CATALOG_MAX_BYTES = 1024 * 1024;
const CATALOG_MAX_MODELS = 200;
const CLI_VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** The account's configuration directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDirectory(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && isAbsolute(configured)) return configured;
  return join(env.HOME !== undefined && isAbsolute(env.HOME) ? env.HOME : homedir(), '.claude');
}

/**
 * The installed CLI's version, as `claude --version` prints it first; undefined if unreadable.
 * Started through the agents' process supervision, the one place they spawn from.
 */
export async function readClaudeVersion(
  executable: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string | undefined> {
  let child: ReturnType<typeof spawnSupervisedProcess>;
  try {
    child = spawnSupervisedProcess({
      executable,
      args: ['--version'],
      cwd: tmpdir(),
      env,
      terminationGraceMs: 1000,
      maxLineBytes: 64 * 1024,
      backgroundWorkTimeoutMs: timeoutMs,
    });
  } catch {
    return undefined;
  }
  child.endInput();
  const timer = setTimeout(() => child.terminate(), timeoutMs);
  let first: string | undefined;
  let exitCode: number | null = null;
  try {
    for await (const item of child.items) {
      if (item.type === 'stdout-line' && first === undefined) first = item.line.trim();
      if (item.type === 'exited') exitCode = item.exitCode;
    }
  } finally {
    clearTimeout(timer);
  }
  const version = first?.split(/\s+/)[0];
  return exitCode === 0 && version !== undefined && CLI_VERSION.test(version) ? version : undefined;
}

function versionParts(version: string): readonly number[] {
  return (CLI_VERSION.exec(version) ?? []).slice(1).map(Number);
}

/** Whether `required` is above `installed`, both `major.minor.patch`. */
function newerThan(required: string, installed: string): boolean {
  const [a, b] = [versionParts(required), versionParts(installed)];
  for (let index = 0; index < 3; index++)
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
}

interface CatalogEntry {
  readonly model: AgentModel;
  readonly minVersion?: string;
}

/** One file's entries and when it was fetched, or why it cannot be used. */
function parseCatalog(text: string): { fetchedAt: number; entries: readonly CatalogEntry[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ModelCatalogError('catalog-unreadable', 'The catalog is not valid JSON.');
  }
  const unsupported = (what: string) =>
    new ModelCatalogError('catalog-format-unsupported', `The catalog's ${what} is not supported.`);
  if (!isRecord(value) || value.version !== CLAUDE_CATALOG_VERSION) throw unsupported('version');
  const fetchedAt = value.fetchedAt;
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) throw unsupported('fetchedAt');
  const config = isRecord(value.catalog) ? value.catalog.config : undefined;
  const models = isRecord(config) ? config.models : undefined;
  if (!Array.isArray(models) || models.length > CATALOG_MAX_MODELS) throw unsupported('model list');
  const entries = models.flatMap((entry): CatalogEntry[] => {
    if (!isRecord(entry)) throw unsupported('model entry');
    const { id, name, section, hidden } = entry;
    const minVersion = entry.min_claude_code_version;
    if (typeof id !== 'string' || id.length === 0) throw unsupported('model id');
    // An id CraftingTable cannot send (a form outside its id grammar) is left out, not the file.
    if (!MODEL_ID.test(id)) return [];
    if (!modelLabel(name)) throw unsupported('model name');
    if (typeof section !== 'string' || !MODEL_SECTION.test(section))
      throw unsupported('model section');
    if (hidden !== undefined && typeof hidden !== 'boolean') throw unsupported('hidden flag');
    if (
      minVersion !== undefined &&
      minVersion !== null &&
      (typeof minVersion !== 'string' || !CLI_VERSION.test(minVersion))
    )
      throw unsupported('minimum version');
    return [
      {
        model: { id, label: name, section, hidden: hidden === true },
        ...(typeof minVersion === 'string' ? { minVersion } : {}),
      },
    ];
  });
  return { fetchedAt, entries };
}

/**
 * A catalog file's text: a regular file the CLI wrote, never through a link, read through one
 * descriptor and bounded, so what is checked is what is read (R-G15 review).
 */
async function readCatalogFile(path: string, name: string): Promise<string> {
  const refused = () =>
    new ModelCatalogError('catalog-unreadable', `${name} is not a catalog file.`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw refused();
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > CATALOG_MAX_BYTES) throw refused();
    const buffer = Buffer.alloc(CATALOG_MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > CATALOG_MAX_BYTES) throw refused();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

/**
 * The models Claude Code's catalog offers this account, after the tier aliases. Of several
 * catalog files, the most recently fetched valid one is read. Entries that need a newer CLI
 * than `installedVersion` are left out, and when the version is unknown, every entry that
 * names one is.
 */
export async function readClaudeModelCatalog(
  configDirectory: string,
  installedVersion: string | undefined,
): Promise<ModelDiscovery> {
  const directory = join(configDirectory, 'cache', 'model-catalog');
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => CATALOG_FILE.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ModelCatalogError('catalog-missing', 'Claude Code has written no model catalog.');
    throw new ModelCatalogError('catalog-unreadable', 'The model catalog cannot be listed.');
  }
  if (names.length === 0)
    throw new ModelCatalogError('catalog-missing', 'Claude Code has written no model catalog.');
  let best: { fetchedAt: number; entries: readonly CatalogEntry[] } | undefined;
  let failure: ModelCatalogError | undefined;
  for (const name of names) {
    const path = join(directory, name);
    try {
      const parsed = parseCatalog(await readCatalogFile(path, name));
      if (best === undefined || parsed.fetchedAt > best.fetchedAt) best = parsed;
    } catch (error) {
      const found =
        error instanceof ModelCatalogError
          ? error
          : new ModelCatalogError('catalog-unreadable', `${name} cannot be read.`);
      // An unsupported format says more than an unreadable file, so it is the one reported.
      if (failure === undefined || found.issue === 'catalog-format-unsupported') failure = found;
    }
  }
  if (best === undefined)
    throw failure ?? new ModelCatalogError('catalog-unreadable', 'No catalog could be read.');
  const usable = best.entries.filter(
    (entry) =>
      entry.minVersion === undefined ||
      (installedVersion !== undefined && !newerThan(entry.minVersion, installedVersion)),
  );
  const versionUnknown =
    installedVersion === undefined && best.entries.some((entry) => entry.minVersion !== undefined);
  // The aliases alone are not a catalog: the list in use stays.
  if (usable.length === 0)
    throw new ModelCatalogError(
      versionUnknown ? 'cli-version-unknown' : 'catalog-empty',
      'The catalog lists no model this Claude Code can use.',
    );
  return {
    models: [...CLAUDE_CODE_ALIASES, ...usable.map((entry) => entry.model)],
    ...(versionUnknown ? { issue: 'cli-version-unknown' as const } : {}),
  };
}
