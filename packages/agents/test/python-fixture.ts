import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PythonWheelSource, WheelRequest } from '../src/python-wheels.js';

/**
 * Test support for R-G17's Python checks: wheels built at test time (a zip written by the host's
 * Python, with fixed timestamps), a `uv.lock` naming them by SHA-256 as PyPI's, and a wheel
 * source that stands in for the daemon's verified store. No PyPI wheel is committed.
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

/** A lock entry of a package with no wheel at all, for refusals. */
export interface SdistOnly {
  readonly name: string;
  readonly version: string;
}

/**
 * The project's `uv.lock`: the virtual root depending on each package, each package from PyPI
 * with its one wheel at a files.pythonhosted.org URL, or with only an sdist.
 */
export function lockFor(
  root: string,
  wheels: readonly FixtureWheel[],
  sdistOnly: readonly SdistOnly[] = [],
): string {
  const names = [...wheels.map((w) => w.name), ...sdistOnly.map((s) => s.name)];
  const lines = [
    'version = 1',
    'revision = 3',
    'requires-python = ">=3.12"',
    '',
    '[[package]]',
    `name = "${root}"`,
    'version = "0.1.0"',
    'source = { virtual = "." }',
    'dependencies = [',
    ...names.map((name) => `    { name = "${name}" },`),
    ']',
    '',
    '[package.metadata]',
    `requires-dist = [${names.map((name) => `{ name = "${name}" }`).join(', ')}]`,
  ];
  for (const wheel of wheels)
    lines.push(
      '',
      '[[package]]',
      `name = "${wheel.name}"`,
      `version = "${wheel.version}"`,
      'source = { registry = "https://pypi.org/simple" }',
      'wheels = [',
      `    { url = "https://files.pythonhosted.org/packages/00/00/${wheel.filename}", hash = "sha256:${wheel.sha256}", size = ${wheel.size} },`,
      ']',
    );
  for (const sdist of sdistOnly)
    lines.push(
      '',
      '[[package]]',
      `name = "${sdist.name}"`,
      `version = "${sdist.version}"`,
      'source = { registry = "https://pypi.org/simple" }',
      `sdist = { url = "https://files.pythonhosted.org/packages/00/00/${sdist.name}-${sdist.version}.tar.gz", hash = "sha256:${'0'.repeat(64)}", size = 10 }`,
    );
  return `${lines.join('\n')}\n`;
}

/**
 * The fixture project copied into `directory`, its dependency on `ctfix-pkg` (VALUE = `value`)
 * built and locked; `extra` adds more files. Returns the wheel so a test can serve it.
 */
export function writePythonProject(
  directory: string,
  wheels: string,
  options: {
    readonly value?: number;
    readonly sdistOnly?: readonly SdistOnly[];
    readonly extraWheels?: readonly FixtureWheel[];
  } = {},
): FixtureWheel {
  cpSync(FIXTURE_PROJECT, directory, { recursive: true });
  const wheel = buildWheel(wheels, 'ctfix-pkg', '1.0', {
    'ctfix_pkg/__init__.py': `VALUE = ${options.value ?? 42}\n`,
  });
  writeFileSync(
    join(directory, 'uv.lock'),
    lockFor('ct-python-fixture', [wheel, ...(options.extraWheels ?? [])], options.sdistOnly),
  );
  return wheel;
}

/** A stand-in for the daemon's store: serves the given wheels by name and digest. */
export class FixtureWheels implements PythonWheelSource {
  readonly requests: WheelRequest[] = [];
  constructor(
    private readonly wheels: readonly FixtureWheel[],
    /** Holds every request until the signal aborts, as a slow download would. */
    private readonly hold = false,
  ) {}

  async wheel(
    request: WheelRequest,
    signal: AbortSignal,
  ): Promise<{ path: string } | { problem: string }> {
    this.requests.push(request);
    if (this.hold)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    if (signal.aborted) return { problem: `fetching ${request.filename} was cancelled` };
    const wheel = this.wheels.find(
      (w) => w.filename === request.filename && w.sha256 === request.sha256,
    );
    return wheel ? { path: wheel.path } : { problem: `${request.filename} is not on PyPI` };
  }
}
