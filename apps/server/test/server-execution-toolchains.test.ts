import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckOnlyManifest } from '@craftingtable/agents';
import { executionStatusResponseSchema } from '@craftingtable/contracts';
import { asDeclaredCheckId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { writePythonProject } from '../../../packages/agents/test/python-fixture.js';
import {
  CycleBackend,
  cleanupExecutionFixtures,
  commitFile,
  declareFixtureChecks,
  directories,
  fixtureRepository,
  git,
  ready,
  registerAndWorktree,
  runToFinish,
  waitFor,
} from './execution-test-support.js';

/**
 * R-G17 increment 1, through the daemon: `toolchains.json` is read at start, the execution
 * status carries the caps and the Python profile's tools as the start probe found them, every
 * run's manifest names the profile, and an adopted check of a Python project re-reads the tools
 * and records them in its receipt, refused when one breaks the rule.
 */

afterEach(cleanupExecutionFixtures);

const OPT_PYTHON = '/opt/craftingtable/python/cpython-3.12.15-linux-x86_64-gnu/bin/python3.12';
const OPT_UV = '/opt/craftingtable/bin/uv';
const optToolchain = existsSync(OPT_PYTHON) && existsSync(OPT_UV);

/** A settings directory holding `toolchains.json`, for a test daemon. */
function settingsWith(toolchains: unknown): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), 'craftingtable-toolchains-settings-'));
  directories.push(configDir);
  writeFileSync(join(configDir, 'toolchains.json'), JSON.stringify(toolchains));
  return { CRAFTINGTABLE_CONFIG_DIR: configDir };
}

/**
 * A manual worktree of a Python project (the fixture project, a packaged project whose `uv.lock`
 * names a wheel built into its tree, so its install needs no network) with committed work and
 * adopted checks that name its environment files, as adoption requires.
 */
async function pythonProject(env: Record<string, string>) {
  const backend = new CycleBackend([]);
  const repository = fixtureRepository();
  writePythonProject(repository);
  git(['add', '--all'], repository);
  git(['commit', '--no-gpg-sign', '-m', 'a Python project'], repository);
  const state = await ready({ backend, env });
  const { worktree } = await registerAndWorktree(state, repository);
  const files = ['pyproject.toml', 'uv.lock'];
  declareFixtureChecks(
    state,
    [
      {
        id: asDeclaredCheckId('fixture'),
        argv: ['git', 'diff', '--check', 'HEAD'],
        definitionPaths: files,
      },
    ],
    Object.fromEntries(
      files.map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(join(repository, path)))
          .digest('hex'),
      ]),
    ),
  );
  commitFile(worktree.path, 'feature.txt', 'feature\n');
  return { state, backend, worktree };
}

it('carries the caps and the configured Python tools, as the start probe found them, in the execution status', async () => {
  const env = settingsWith({
    version: 1,
    python: { interpreter: '/usr/bin/python3.14', version: '3.14' },
    // A root-owned file that answers no version probe: shown refused, the start goes on.
    uv: { path: '/usr/bin/env', version: '0.12' },
    limits: { tasksMax: 2048 },
  });
  const state = await ready({ env });
  const status = () => state.context.services.executionStatus();
  await waitFor(() => status().toolchains.tools.length === 2, 'the start probe');
  const toolchains = status().toolchains;
  expect(toolchains.limits).toEqual({ memoryMax: '8G', tasksMax: 2048 });
  expect(toolchains.python?.interpreter).toBe('/usr/bin/python3.14');
  expect(toolchains.tools[0]).toMatchObject({
    tool: 'python',
    identity: { uid: 0, version: expect.stringMatching(/^3\.14\./) },
  });
  expect(toolchains.tools[0]?.problem).toBeUndefined();
  expect(toolchains.tools[1]).toMatchObject({ tool: 'uv', problem: { code: 'probe-failed' } });
  // The answer the browser gets is valid under the contract.
  expect(() => executionStatusResponseSchema.parse(status())).not.toThrow();
});

it("refuses a Python project's adopted check through the daemon when a tool breaks the rule, recording what it read", async () => {
  const { state, backend, worktree } = await pythonProject(
    settingsWith({
      version: 1,
      python: { interpreter: '/usr/bin/python3.14', version: '3.12' },
      uv: { path: '/usr/bin/env', version: '0.12' },
    }),
  );
  const review = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  // The manifest names the profile.
  const request = backend.launches.filter((r) => r.cwd === worktree.path).at(-1)!;
  const manifest = JSON.parse(
    readFileSync(join(request.buildEnvironment!.binDirectory, '..', 'manifest.json'), 'utf8'),
  ) as CheckOnlyManifest;
  expect(manifest.python).toEqual({
    interpreter: '/usr/bin/python3.14',
    version: '3.12',
    uv: { path: '/usr/bin/env', version: '0.12' },
  });
  const receipts = state.context.storage.runtimeEvidence
    .checkReceipts(state.workspaceId, review)
    .map((r) => JSON.parse(r.receipt));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ origin: 'daemon', success: false });
  expect(receipts[0].diagnostic).toContain('does not fit the configured 3.12');
  expect(receipts[0].python.tools[0]).toMatchObject({
    tool: 'python',
    path: '/usr/bin/python3.14',
  });
  // What the check read reached Tools: read again when the check ran, after the start probe.
  const python = state.context.services.executionStatus().toolchains.tools[0];
  expect(python?.problem?.code).toBe('version-mismatch');
  expect(python?.checkedAt && python.checkedAt >= receipts[0].at).toBe(true);
});

const userManager = spawnSync('systemctl', ['--user', 'is-system-running'], {
  encoding: 'utf8',
}).stdout?.trim();

it.skipIf(!['running', 'degraded'].includes(userManager ?? ''))(
  "runs a review's adopted check in a unit with the configured caps (R-G17 decision 7)",
  async () => {
    const backend = new CycleBackend([]);
    const state = await ready({
      backend,
      env: {
        ...settingsWith({ version: 1, limits: { memoryMax: '3G', tasksMax: 321 } }),
        CRAFTINGTABLE_CHECK_CONFINEMENT: 'systemd',
      },
    });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    declareFixtureChecks(state, [
      {
        id: asDeclaredCheckId('caps'),
        argv: [
          'sh',
          '-c',
          'g=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); echo CAPS tasks=$(cat $g/pids.max) memory=$(cat $g/memory.max)',
        ],
        definitionPaths: [],
      },
    ]);
    commitFile(worktree.path, 'feature.txt', 'feature\n');
    const review = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    const receipt = JSON.parse(
      state.context.storage.runtimeEvidence.checkReceipts(state.workspaceId, review)[0]!.receipt,
    );
    expect(receipt).toMatchObject({ success: true });
    const log = readFileSync(join(state.context.config.dataDir, receipt.logPath), 'utf8');
    expect(log).toContain(`CAPS tasks=321 memory=${3 * 1024 ** 3}`);
  },
);

it.skipIf(!optToolchain)(
  "records the operator's CPython and uv in a Python project's adopted-check receipt, run through the daemon",
  async () => {
    const { state, worktree } = await pythonProject(
      settingsWith({
        version: 1,
        python: { interpreter: OPT_PYTHON, version: '3.12' },
        uv: { path: OPT_UV, version: '0.12' },
      }),
    );
    const review = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    const receipts = state.context.storage.runtimeEvidence
      .checkReceipts(state.workspaceId, review)
      .map((r) => JSON.parse(r.receipt));
    expect(receipts[0]).toMatchObject({ origin: 'daemon', success: true, clean: true });
    expect(
      receipts[0].python.tools.map((tool: { tool: string; path: string }) => [
        tool.tool,
        tool.path,
      ]),
    ).toEqual([
      ['python', OPT_PYTHON],
      ['uv', OPT_UV],
    ]);
    expect(receipts[0].python.profileDigest).toMatch(/^[0-9a-f]{64}$/);
  },
);

it('gives a repository without a root uv.lock no Python: its check runs as before, whatever the profile', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'craftingtable-toolchains-settings-'));
  directories.push(configDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'toolchains.json'),
    JSON.stringify({
      version: 1,
      python: { interpreter: '/usr/bin/python3.14', version: '3.12' },
      uv: { path: '/usr/bin/env', version: '0.12' },
    }),
  );
  const backend = new CycleBackend([]);
  const state = await ready({ backend, env: { CRAFTINGTABLE_CONFIG_DIR: configDir } });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  declareFixtureChecks(state);
  commitFile(worktree.path, 'feature.txt', 'feature\n');
  const review = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  const receipts = state.context.storage.runtimeEvidence
    .checkReceipts(state.workspaceId, review)
    .map((r) => JSON.parse(r.receipt));
  expect(receipts[0]).toMatchObject({ origin: 'daemon', success: true });
  expect(receipts[0].python).toBeUndefined();
});
