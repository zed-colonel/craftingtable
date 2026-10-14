import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test support for Python checks (R-G17, R-G19): the fixture project, a packaged uv project with a
 * console script, whose dependency is a wheel built at test time (a zip written by the host's
 * Python, with fixed timestamps) in its `vendor/`, locked with the operator's uv, offline. Its
 * install needs no network: uv builds a `uv_build` project itself, and the wheel is in the tree.
 * No file from PyPI is committed.
 */

export const FIXTURE_PROJECT = new URL('./fixtures/python-project/', import.meta.url).pathname;
export const OPT_PYTHON =
  '/opt/craftingtable/python/cpython-3.12.15-linux-x86_64-gnu/bin/python3.12';
export const OPT_UV = '/opt/craftingtable/bin/uv';

export interface FixtureWheel {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

const BUILD_WHEEL = `
import base64, hashlib, json, sys, zipfile
spec = json.load(sys.stdin)
name, version, out = spec["module"], spec["version"], spec["out"]
files = {path: text.encode() for path, text in spec["files"].items()}
info = f"{name}-{version}.dist-info"
files[f"{info}/METADATA"] = f"Metadata-Version: 2.1\\nName: {spec['project']}\\nVersion: {version}\\n".encode()
files[f"{info}/WHEEL"] = b"Wheel-Version: 1.0\\nGenerator: craftingtable-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"
def digest(data):
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
record = "".join(f"{p},{digest(d)},{len(d)}\\n" for p, d in files.items()) + f"{info}/RECORD,,\\n"
files[f"{info}/RECORD"] = record.encode()
with zipfile.ZipFile(out, "w") as archive:
    for path, data in files.items():
        entry = zipfile.ZipInfo(path, date_time=(2020, 1, 1, 0, 0, 0))
        archive.writestr(entry, data)
`;

/** A pure wheel of `project` (module `project` with dashes as underscores) holding `files`. */
export function buildWheel(
  directory: string,
  project: string,
  version: string,
  files: Readonly<Record<string, string>>,
): FixtureWheel {
  mkdirSync(directory, { recursive: true });
  const module = project.replaceAll('-', '_');
  const filename = `${module}-${version}-py3-none-any.whl`;
  const path = join(directory, filename);
  const built = spawnSync('/usr/bin/python3', ['-I', '-c', BUILD_WHEEL], {
    input: JSON.stringify({ project, module, version, files, out: path }),
    encoding: 'utf8',
  });
  if (built.status !== 0) throw new Error(`building ${filename} failed: ${built.stderr}`);
  const bytes = readFileSync(path);
  return {
    name: project,
    version,
    filename,
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

/**
 * A dependency in the tree whose build backend, also in the tree, sleeps for two minutes before
 * failing: an install that is still running when a test cancels it or its time limit passes.
 */
const SLOW_DEPENDENCY: Readonly<Record<string, string>> = {
  'slow/pyproject.toml': [
    '[project]',
    'name = "ctslow"',
    'version = "1.0"',
    '',
    '[build-system]',
    'requires = []',
    'build-backend = "slowbackend"',
    'backend-path = ["."]',
    '',
  ].join('\n'),
  'slow/slowbackend.py': [
    'import time',
    '',
    '',
    'def get_requires_for_build_wheel(config_settings=None):',
    '    return []',
    '',
    '',
    'def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):',
    '    print("CTSLOW-BUILDING", flush=True)',
    '    time.sleep(120)',
    '    raise RuntimeError("never built")',
    '',
  ].join('\n'),
};

/** Locks the project in `directory` with the operator's uv, offline, with no configuration. */
export function lockProject(directory: string): void {
  const cache = mkdtempSync(join(tmpdir(), 'ct-python-lock-cache-'));
  try {
    const locked = spawnSync(OPT_UV, ['lock', '--offline', '--quiet', '--python', OPT_PYTHON], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: cache,
        UV_CACHE_DIR: cache,
        UV_NO_CONFIG: '1',
        UV_PYTHON_DOWNLOADS: 'never',
      },
    });
    if (locked.status !== 0) throw new Error(`uv lock failed: ${locked.stderr}`);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

/**
 * The fixture project copied into `directory`: its dependency `ctfix-pkg` (VALUE = `value`)
 * built into `vendor/`, `extra` files added, and, with `slow`, a dependency whose build never
 * ends; then locked. Returns the wheel.
 */
export function writePythonProject(
  directory: string,
  options: { readonly value?: number; readonly slow?: boolean } = {},
): FixtureWheel {
  cpSync(FIXTURE_PROJECT, directory, { recursive: true });
  const wheel = buildWheel(join(directory, 'vendor'), 'ctfix-pkg', '1.0', {
    'ctfix_pkg/__init__.py': `VALUE = ${options.value ?? 42}\n`,
  });
  if (options.slow) {
    for (const [path, content] of Object.entries(SLOW_DEPENDENCY)) {
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
    const pyproject = join(directory, 'pyproject.toml');
    writeFileSync(
      pyproject,
      readFileSync(pyproject, 'utf8')
        .replace('dependencies = ["ctfix-pkg"]', 'dependencies = ["ctfix-pkg", "ctslow"]')
        .replace('[tool.uv.sources]\n', '[tool.uv.sources]\nctslow = { path = "slow" }\n'),
    );
  }
  lockProject(directory);
  return wheel;
}
