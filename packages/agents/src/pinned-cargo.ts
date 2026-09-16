/** Explicit Cargo adapter. Child commands stay in the coding agent's process group. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface PinnedCargoManifest {
  readonly runtimeId: string;
  readonly runId: string;
  readonly cargoExecutable: string;
  readonly gitExecutable: string;
  readonly workspacePath: string;
  readonly targetDirectory: string;
  readonly packages: readonly { name: string; path: string }[];
  readonly files: readonly { path: string; digest: string }[];
  readonly configPath: string;
  readonly configDigest: string;
  readonly receiptPath: string;
}
export const cargoManifestDigest = (content: string | Uint8Array) =>
  createHash('sha256').update(content).digest('hex');
export function prepareCargoLauncher(directory: string, manifest: PinnedCargoManifest) {
  const path = join(directory, 'manifest.json'),
    binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  const content = JSON.stringify(manifest, null, 2),
    manifestDigest = cargoManifestDigest(content);
  writeFileSync(path, content, { mode: 0o400 });
  writeFileSync(
    join(binDirectory, 'cargo'),
    `#!${process.execPath}\nimport(${JSON.stringify(import.meta.url)}).then(m=>m.runPinnedCargo(${JSON.stringify(path)},${JSON.stringify(manifestDigest)},process.argv.slice(2))).catch(e=>{console.error(e.message);process.exitCode=1;});\n`,
    { mode: 0o500 },
  );
  chmodSync(join(binDirectory, 'cargo'), 0o500);
  return { binDirectory, manifestPath: path, manifestDigest };
}
export function runPinnedCargo(path: string, expectedDigest: string, args: string[]): void {
  const raw = readFileSync(path, 'utf8');
  if (cargoManifestDigest(raw) !== expectedDigest)
    throw new Error('Pinned build manifest changed.');
  const m = JSON.parse(raw) as PinnedCargoManifest;
  const verify = () => {
    for (const f of [...m.files, { path: m.configPath, digest: m.configDigest }]) {
      if (
        !lstatSync(f.path).isFile() ||
        realpathSync(f.path) !== resolve(f.path) ||
        cargoManifestDigest(readFileSync(f.path)) !== f.digest
      )
        throw new Error(`Pinned source changed: ${f.path}`);
    }
  };
  verify();
  // Prevent caller-supplied configuration or cargo aliases from replacing the supplied graph.
  if (args.some((a) => a === '--config' || a.startsWith('--config=') || a.startsWith('+')))
    throw new Error('Pinned Cargo does not accept configuration or toolchain overrides.');
  const command = args[0] ?? 'help';
  const builds = new Set([
    'build',
    'b',
    'check',
    'c',
    'test',
    't',
    'bench',
    'clippy',
    'doc',
    'd',
    'run',
    'r',
    'rustc',
    'rustdoc',
  ]);
  const harmless = new Set([
    'metadata',
    'tree',
    'update',
    'generate-lockfile',
    'fetch',
    'fmt',
    'clean',
    'help',
    'version',
    '--version',
    '-V',
    '--help',
    '-h',
  ]);
  if (!builds.has(command) && !harmless.has(command))
    throw new Error(`Cargo command ${command} is not supported by the pinned adapter.`);
  const gitState = () => {
    const head = spawnSync(m.gitExecutable, ['rev-parse', 'HEAD'], {
      cwd: m.workspacePath,
      shell: false,
      encoding: 'utf8',
      timeout: 30000,
    });
    const dirty = spawnSync(m.gitExecutable, ['status', '--porcelain'], {
      cwd: m.workspacePath,
      shell: false,
      encoding: 'utf8',
      timeout: 30000,
    });
    return {
      headSha: head.status === 0 ? head.stdout.trim() : '',
      clean: dirty.status === 0 && !dirty.stdout.trim(),
    };
  };
  const version = spawnSync(m.cargoExecutable, ['--version', '--verbose'], {
    cwd: m.workspacePath,
    shell: false,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (version.status !== 0) throw new Error('Could not identify Cargo toolchain.');
  const toolchain = version.stdout.trim();
  const before = gitState();
  const options = ['--config', m.configPath];
  const env = { ...process.env, CARGO_TARGET_DIR: m.targetDirectory };
  let resolvedPackages: { name: string; path: string }[] = [];
  if (builds.has(command) || command === 'metadata' || command === 'tree') {
    const metadataArgs = ['metadata', '--format-version', '1', ...options];
    for (let i = 1; i < args.length && args[i] !== '--'; i++) {
      const a = args[i]!;
      if (
        ['--offline', '--locked', '--frozen', '--all-features', '--no-default-features'].includes(a)
      )
        metadataArgs.push(a);
      else if (['--manifest-path', '--features', '-F', '--filter-platform'].includes(a)) {
        const value = args[++i];
        if (!value) throw new Error(`Missing value for ${a}`);
        metadataArgs.push(a, value);
      } else if (
        ['--manifest-path=', '--features=', '--filter-platform='].some((p) => a.startsWith(p))
      )
        metadataArgs.push(a);
    }
    const observed = spawnSync(m.cargoExecutable, metadataArgs, {
      cwd: m.workspacePath,
      env,
      shell: false,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000,
    });
    if (observed.status !== 0)
      throw new Error(
        `Pinned dependency resolution failed. Align Cargo version constraints with the pinned crates; registry fallback is not accepted.\n${observed.stderr ?? observed.error?.message ?? ''}`,
      );
    const graph = JSON.parse(observed.stdout) as {
      packages: { id: string; name: string; manifest_path: string; source: string | null }[];
      resolve: { nodes: { id: string }[] } | null;
    };
    if (!graph.resolve) throw new Error('Cargo did not return a resolved dependency graph.');
    const ids = new Set(graph.resolve.nodes.map((n) => n.id));
    for (const pkg of graph.packages.filter((p) => ids.has(p.id))) {
      const pin = m.packages.find((p) => p.name === pkg.name);
      if (!pin) continue;
      if (
        pkg.source !== null ||
        realpathSync(dirname(pkg.manifest_path)) !== realpathSync(pin.path)
      )
        throw new Error(`Refusing unpinned ${pkg.name}: ${pkg.manifest_path}`);
      resolvedPackages.push({ name: pkg.name, path: pin.path });
    }
    if (m.packages.length && !resolvedPackages.length)
      throw new Error('The resolved build graph uses none of the configured upstream packages.');
  }
  const separator = args.indexOf('--');
  const actual =
    separator < 0
      ? [...args, ...options]
      : [...args.slice(0, separator), ...options, ...args.slice(separator)];
  const result = spawnSync(m.cargoExecutable, actual, {
    cwd: m.workspacePath,
    env,
    shell: false,
    stdio: 'inherit',
  });
  verify();
  const after = gitState();
  if (builds.has(command))
    appendFileSync(
      m.receiptPath,
      JSON.stringify({
        runtimeId: m.runtimeId,
        runId: m.runId,
        manifestDigest: expectedDigest,
        command,
        args,
        toolchain,
        toolchainDigest: cargoManifestDigest(toolchain),
        headSha: after.headSha,
        clean: before.clean && after.clean && before.headSha === after.headSha,
        packages: resolvedPackages,
        success: result.status === 0,
        at: new Date().toISOString(),
      }) + '\n',
      { mode: 0o600 },
    );
  process.exitCode = result.status ?? 1;
}
