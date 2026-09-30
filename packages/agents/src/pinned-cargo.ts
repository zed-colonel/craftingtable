/**
 * Explicit Cargo adapter. Build commands are run by the daemon when the run has a spool (R-G4);
 * other commands, and builds without a spool, stay in the coding agent's process group.
 */
import type { ExecutionScope } from '@craftingtable/domain';
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
import { delimiter, dirname, join, resolve, relative, isAbsolute } from 'node:path';

export interface PinnedCargoManifest {
  readonly nativeVerification?: {
    approvalId: string;
    hostDigest: string;
    auditDigest: string;
    fixtureDigest: string;
    toolchainDigest: string;
    toolchain: string;
  };
  readonly checkTimeoutMs?: number;
  readonly forbiddenPackages?: readonly string[];
  readonly verification?: {
    version: 1;
    mode: 'scoped-checks' | 'current-upstream-build';
    scope?: ExecutionScope;
    reason: string;
  };
  readonly dependencyIdentities?: readonly {
    alias: string;
    commitSha: string;
    treeSha?: string;
    purpose: string;
    /** The declared transition that decided this link's source (ADR-069). */
    transition?: { slice: string; recordId?: string };
  }[];
  /**
   * Where each supplied upstream comes from (R-G13 increment 2): the exact commit and tree, the
   * upstream repository's Git directory, and its packages relative to the source's root. The
   * daemon builds from its own verified checkout of these, never from the run's copies, which
   * the agent can write. Runs prepared before this field keep building from the run's copies.
   */
  readonly dependencySources?: readonly {
    readonly alias: string;
    readonly commitSha: string;
    readonly treeSha?: string;
    readonly gitDirectory: string;
    readonly packages: readonly { readonly name: string; readonly path: string }[];
  }[];
  readonly historicalPreparationId?: string;
  readonly localCi?: import('./local-check.js').LocalCiConfig;
  readonly runtimeId: string;
  readonly runId: string;
  readonly cargoExecutable: string;
  readonly gitExecutable: string;
  /**
   * The worktree's git directory and the repository's common directory, resolved by the daemon
   * before the agent starts (R-G4). Daemon Git on the worktree uses them rather than following
   * the worktree's `.git` pointer, which the agent can rewrite.
   */
  readonly gitDirectory?: string;
  readonly gitCommonDirectory?: string;
  readonly workspacePath: string;
  readonly targetDirectory: string;
  readonly packages: readonly { name: string; path: string }[];
  readonly files: readonly { path: string; digest: string }[];
  readonly configPath: string;
  readonly configDigest: string;
  readonly receiptPath: string;
  /**
   * The repository's adopted checks the run's gates are held to (R-G13). `ct-check
   * --declared <id>` runs one of them; the command comes from here, never from the request.
   */
  readonly declaredChecks?: import('@craftingtable/domain').ManifestDeclaredChecks;
}
export const cargoManifestDigest = (content: string | Uint8Array) =>
  createHash('sha256').update(content).digest('hex');

/** Cargo commands whose success is a pinned build receipt. */
export const PINNED_BUILD_COMMANDS: ReadonlySet<string> = new Set([
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
const HARMLESS_COMMANDS = new Set([
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

/** Refuses caller configuration or toolchain overrides that could replace the supplied graph. */
export function assertPinnedCargoArguments(args: readonly string[]): string {
  if (args.some((a) => a === '--config' || a.startsWith('--config=') || a.startsWith('+')))
    throw new Error('Pinned Cargo does not accept configuration or toolchain overrides.');
  const command = args[0] ?? 'help';
  if (!PINNED_BUILD_COMMANDS.has(command) && !HARMLESS_COMMANDS.has(command))
    throw new Error(`Cargo command ${command} is not supported by the pinned adapter.`);
  return command;
}

/** Checks the supplied pinned sources and configuration are unchanged. */
export function verifyPinnedSources(m: PinnedCargoManifest): void {
  for (const f of [...m.files, { path: m.configPath, digest: m.configDigest }]) {
    if (
      !lstatSync(f.path).isFile() ||
      realpathSync(f.path) !== resolve(f.path) ||
      cargoManifestDigest(readFileSync(f.path)) !== f.digest
    )
      throw new Error(`Pinned source changed: ${f.path}`);
  }
}

/** `cargo metadata` arguments that resolve the graph a command's own arguments select. */
export function pinnedMetadataArguments(m: PinnedCargoManifest, args: readonly string[]): string[] {
  const metadataArgs = ['metadata', '--format-version', '1', '--config', m.configPath];
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
  return metadataArgs;
}

/**
 * The supplied packages the resolved graph actually uses. Refuses a graph that resolves a
 * pinned package from anywhere else, or a package this scope forbids.
 */
export function pinnedResolvedPackages(
  m: PinnedCargoManifest,
  metadataOutput: string,
): { name: string; path: string }[] {
  const graph = JSON.parse(metadataOutput) as {
    packages: { id: string; name: string; manifest_path: string; source: string | null }[];
    resolve: { nodes: { id: string }[] } | null;
  };
  if (!graph.resolve) throw new Error('Cargo did not return a resolved dependency graph.');
  const ids = new Set(graph.resolve.nodes.map((n) => n.id));
  const resolvedPackages: { name: string; path: string }[] = [];
  for (const pkg of graph.packages.filter((p) => ids.has(p.id))) {
    if (m.forbiddenPackages?.includes(pkg.name))
      throw new Error(
        `Prepare exact historical dependencies before building ${pkg.name} in this independent scope.`,
      );
    const pin = m.packages.find((p) => p.name === pkg.name);
    if (!pin) continue;
    if (pkg.source !== null || realpathSync(dirname(pkg.manifest_path)) !== realpathSync(pin.path))
      throw new Error(`Refusing unpinned ${pkg.name}: ${pkg.manifest_path}`);
    resolvedPackages.push({ name: pkg.name, path: pin.path });
  }
  return resolvedPackages;
}

/** The command's arguments with the supplied configuration inserted before any `--`. */
export function pinnedCargoArguments(m: PinnedCargoManifest, args: readonly string[]): string[] {
  const options = ['--config', m.configPath];
  const separator = args.indexOf('--');
  return separator < 0
    ? [...args, ...options]
    : [...args.slice(0, separator), ...options, ...args.slice(separator)];
}

/** A build receipt's `kind`: supplementary when an integration build used no supplied package. */
export function pinnedReceiptKind(
  m: PinnedCargoManifest,
  resolvedPackages: readonly unknown[],
): { kind?: 'supplementary-check' } {
  // Supplementary checks may legitimately have no upstream dependency. They
  // remain pinned and auditable, but cannot establish integration evidence.
  return m.verification?.mode !== 'scoped-checks' && m.packages.length && !resolvedPackages.length
    ? { kind: 'supplementary-check' }
    : {};
}

/**
 * Writes the run's pinned Cargo launcher. With a spool, build commands only ask the daemon to
 * run the build and record its receipt (R-G4); other commands still run here, unrecorded.
 */
export function prepareCargoLauncher(
  directory: string,
  manifest: PinnedCargoManifest,
  spool?: { readonly directory: string; readonly replies: string; readonly limitMs: number },
) {
  const path = join(directory, 'manifest.json'),
    binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  const content = JSON.stringify(manifest, null, 2),
    manifestDigest = cargoManifestDigest(content);
  writeFileSync(path, content, { mode: 0o400 });
  writeFileSync(
    join(binDirectory, 'cargo'),
    `#!${process.execPath}\nimport(${JSON.stringify(import.meta.url)}).then(m=>m.runPinnedCargo(${JSON.stringify(path)},${JSON.stringify(manifestDigest)},process.argv.slice(2)${spool ? `,${JSON.stringify(spool)}` : ''})).catch(e=>{console.error(e.message);process.exitCode=1;});\n`,
    { mode: 0o500 },
  );
  chmodSync(join(binDirectory, 'cargo'), 0o500);
  return { binDirectory, manifestPath: path, manifestDigest, manifest: content };
}
export async function runPinnedCargo(
  path: string,
  expectedDigest: string,
  args: string[],
  spool?: { readonly directory: string; readonly replies: string; readonly limitMs: number },
): Promise<void> {
  const raw = readFileSync(path, 'utf8');
  if (cargoManifestDigest(raw) !== expectedDigest)
    throw new Error('Pinned build manifest changed.');
  const m = JSON.parse(raw) as PinnedCargoManifest;
  const verify = () => verifyPinnedSources(m);
  verify();
  const command = assertPinnedCargoArguments(args);
  const builds = PINNED_BUILD_COMMANDS;
  if (spool && builds.has(command)) {
    const { submitCheck } = (await import(
      new URL(
        import.meta.url.endsWith('.ts') ? './check-spool.ts' : './check-spool.js',
        import.meta.url,
      ).href
    )) as typeof import('./check-spool.js');
    await submitCheck(spool.directory, spool.replies, 'cargo', args, spool.limitMs);
    return;
  }
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
  const env = { ...process.env, CARGO_TARGET_DIR: m.targetDirectory };
  let resolvedPackages: { name: string; path: string }[] = [];
  if (builds.has(command) || command === 'metadata' || command === 'tree') {
    const observed = spawnSync(m.cargoExecutable, pinnedMetadataArguments(m, args), {
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
    resolvedPackages = pinnedResolvedPackages(m, observed.stdout);
  }
  const actual = pinnedCargoArguments(m, args);
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
      `${JSON.stringify({
        ...pinnedReceiptKind(m, resolvedPackages),
        runtimeId: m.runtimeId,
        runId: m.runId,
        ...(m.verification
          ? {
              verificationMode: m.verification.mode,
              policyDigest: cargoManifestDigest(JSON.stringify(m.verification)),
            }
          : {}),
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
      })}\n`,
      { mode: 0o600 },
    );
  process.exitCode = result.status ?? 1;
}

/** Historical characterization is deliberately outside the current pinned-build receipt format. */
export interface HistoricalCargoManifest {
  readonly sourceRoots: readonly string[];
  readonly cargoHome?: string;
  readonly preparationId: string;
  readonly sources: readonly { alias: string; commitSha: string }[];
  readonly cargoExecutable: string;
  readonly workspacePath: string;
  readonly targetDirectory: string;
  readonly files: readonly { path: string; digest: string }[];
  readonly receiptPath: string;
  readonly logDirectory: string;
  readonly timeoutMs: number;
}
export function prepareHistoricalCargoLauncher(
  directory: string,
  manifest: HistoricalCargoManifest,
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'manifest.json');
  const text = JSON.stringify(manifest, null, 2);
  writeFileSync(path, text, { mode: 0o400 });
  const launcher = join(directory, 'historical-cargo');
  writeFileSync(
    launcher,
    `#!${process.execPath}\nimport(${JSON.stringify(import.meta.url)}).then(m=>m.runHistoricalCargo(${JSON.stringify(path)},${JSON.stringify(cargoManifestDigest(text))},process.argv.slice(2))).catch(e=>{console.error(e.message);process.exitCode=1;});\n`,
    { mode: 0o500 },
  );
  chmodSync(launcher, 0o500);
  return {
    launcher,
    manifestPath: path,
    workspacePath: manifest.workspacePath,
    receiptPath: manifest.receiptPath,
  };
}
export function runHistoricalCargo(path: string, expectedDigest: string, args: string[]): void {
  const raw = readFileSync(path, 'utf8');
  if (cargoManifestDigest(raw) !== expectedDigest) throw new Error('Historical manifest changed.');
  const m = JSON.parse(raw) as HistoricalCargoManifest;
  const startedAt = new Date().toISOString();
  const id = `${Date.now()}-${process.pid}`;
  let success = false;
  let diagnostic = '';
  let exitCode: number | null = null;
  let log = '';
  let toolchain = '';
  let resolvedPackages: {
    name: string;
    version: string;
    source: string | null;
    manifest_path: string;
  }[] = [];
  const deadline = Date.now() + m.timeoutMs;
  const remaining = () => {
    const duration = deadline - Date.now();
    if (duration <= 0) throw new Error('Historical command time limit reached.');
    return duration;
  };
  const verify = () => {
    for (const file of m.files)
      if (
        !lstatSync(file.path).isFile() ||
        realpathSync(file.path) !== resolve(file.path) ||
        cargoManifestDigest(readFileSync(file.path)) !== file.digest
      )
        throw new Error(`Historical source changed: ${file.path}`);
  };
  try {
    verify();
    if (
      !['fetch', 'metadata', 'tree', 'build', 'check', 'test', 'bench', 'clippy'].includes(
        args[0] ?? '',
      ) ||
      args.some(
        (a) =>
          a.startsWith('+') ||
          ['--config', '--manifest-path', '--target-dir', '--lockfile-path'].some(
            (flag) => a === flag || a.startsWith(`${flag}=`),
          ),
      )
    )
      throw new Error(
        'Historical Cargo supports bounded collection on its original workspace only; configuration, manifest and toolchain overrides are not allowed.',
      );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CARGO_TARGET_DIR: m.targetDirectory,
      RUSTUP_AUTO_INSTALL: '0',
      PATH: `${dirname(m.cargoExecutable)}${delimiter}${process.env.PATH ?? ''}`,
      ...(m.cargoHome ? { CARGO_HOME: m.cargoHome } : {}),
    };
    // Do not inherit the current run adapter or externally supplied Cargo patches/configuration.
    for (const key of Object.keys(env)) if (key.startsWith('CARGO_PATCH_')) delete env[key];
    const version = spawnSync(m.cargoExecutable, ['--version', '--verbose'], {
      cwd: m.workspacePath,
      env,
      shell: false,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    toolchain = `${version.stdout ?? ''}${version.stderr ?? ''}`;
    if (version.status !== 0) throw new Error(`Historical toolchain unavailable: ${toolchain}`);
    if (args[0] !== 'fetch') {
      const metadataArgs = ['metadata', '--format-version', '1', '--locked'];
      for (let i = 1; i < args.length && args[i] !== '--'; i++) {
        const arg = args[i]!;
        if (
          ['--offline', '--frozen', '--all-features', '--no-default-features'].includes(arg) ||
          arg.startsWith('--features=')
        )
          metadataArgs.push(arg);
        else if (['--features', '-F'].includes(arg) && args[i + 1])
          metadataArgs.push(arg, args[++i]!);
      }
      const metadata = spawnSync(m.cargoExecutable, metadataArgs, {
        cwd: m.workspacePath,
        env,
        shell: false,
        encoding: 'utf8',
        timeout: remaining(),
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
      });
      log = `DEPENDENCY RESOLUTION\n${metadata.stderr ?? ''}`;
      if (metadata.status !== 0 || metadata.error) {
        exitCode = metadata.status;
        throw new Error(
          metadata.error?.message ?? 'Historical dependency resolution failed; see retained log.',
        );
      }
      const graph = JSON.parse(metadata.stdout) as { packages: typeof resolvedPackages };
      resolvedPackages = graph.packages.map((p) => ({
        name: p.name,
        version: p.version,
        source: p.source,
        manifest_path: p.manifest_path,
      }));
      for (const pkg of resolvedPackages.filter((p) => p.source === null)) {
        const path = realpathSync(dirname(pkg.manifest_path));
        if (
          !m.sourceRoots.some((root) => {
            const child = relative(realpathSync(root), path);
            return (
              child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../'))
            );
          })
        )
          throw new Error(
            `Historical dependency escaped the prepared sources: ${pkg.name} at ${path}`,
          );
      }
    }
    const separator = args.indexOf('--');
    const locked = args.slice(0, separator < 0 ? args.length : separator).includes('--locked')
      ? []
      : ['--locked'];
    const actual =
      separator < 0
        ? [...args, ...locked]
        : [...args.slice(0, separator), ...locked, ...args.slice(separator)];
    const result = spawnSync(m.cargoExecutable, actual, {
      cwd: m.workspacePath,
      env,
      shell: false,
      encoding: 'utf8',
      timeout: remaining(),
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
    exitCode = result.status;
    log += `\nSTDOUT\n${result.stdout ?? ''}\nSTDERR\n${result.stderr ?? ''}`;
    if (result.error) diagnostic = result.error.message;
    verify();
    success = result.status === 0 && !result.error;
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : String(error);
  }
  const logPath = join(m.logDirectory, `${id}.log`);
  writeFileSync(logPath, `${log}\n${diagnostic}`, { mode: 0o600 });
  appendFileSync(
    m.receiptPath,
    `${JSON.stringify({ kind: 'historical-baseline-command-v1', preparationId: m.preparationId, manifestDigest: expectedDigest, sources: m.sources, args, enforcedLocked: true, resolvedPackages, toolchain, startedAt, finishedAt: new Date().toISOString(), success, exitCode, diagnostic, logPath, logDigest: cargoManifestDigest(`${log}\n${diagnostic}`), currentRuntimeVerification: false })}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(log);
  if (diagnostic) process.stderr.write(`${diagnostic}\n`);
  process.exitCode = success ? 0 : 1;
}
