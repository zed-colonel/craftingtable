import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import type { AgentLaunchRequest, PinnedCargoManifest } from '@craftingtable/agents';
import type { DeclaredCheck } from '@craftingtable/domain';
import { afterEach, expect } from 'vitest';
import {
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  declareFixtureChecks,
  designDone,
  git,
  HOST_GIT,
  implementationDone,
  itNeedsCargo,
  mutationHeaders,
  runLauncher,
  runToFinish,
  scopeReport,
  scopeTree,
  slicedFixture,
  startCycle,
  waitFor,
  withoutDaemonChecks,
} from './execution-test-support.js';
import { CheckDefinitionChangedError } from './services/errors.js';

afterEach(cleanupExecutionFixtures);

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * An independent implementation slice with a pinned environment, so its reviews are scoped,
 * and adopted `checks` for its repository unless `checks` is null (R-G13).
 */
async function scopedRuntimeFixture(
  checks?: DeclaredCheck[] | null,
  definitionDigests?: Record<string, string>,
) {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s) => ({ ...s, mode: 'implementation' })),
    work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
  }));
  const svc = f.state.context.services.runtimeEvidenceService;
  if (checks !== null) declareFixtureChecks(f.state, checks, definitionDigests);
  await svc.configure(f.auth, f.state.workspaceId, f.parentScope.definitionId, {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [],
    consumers: [{ alias: 'local', upstreams: [] }],
    environments: [
      {
        id: 'local',
        kind: 'local-development' as const,
        identityDigest: '1'.repeat(64),
        fixtureDigest: '2'.repeat(64),
        toolchainDigest: '3'.repeat(64),
        authorization: 'Local development checks',
      },
    ],
  });
  const tree = await scopeTree(f, f.scopes[0]!);
  commitFile(tree.path, 'slice.txt', 'slice implementation');
  return { ...f, svc, tree };
}

/**
 * Appends a receipt line exactly as a check launcher would, with every field a gate compares,
 * from files the run can read. Any agent can do this (SEC-01).
 */
function appendReceipt(request: AgentLaunchRequest, fields: Record<string, unknown>) {
  const raw = readFileSync(
    join(request.buildEnvironment!.binDirectory, '../manifest.json'),
    'utf8',
  );
  const m = JSON.parse(raw) as PinnedCargoManifest;
  const headSha = execFileSync(HOST_GIT, ['rev-parse', 'HEAD'], {
    cwd: request.cwd,
    encoding: 'utf8',
  }).trim();
  appendFileSync(
    m.receiptPath,
    `${JSON.stringify({
      kind: 'scoped-check',
      runtimeId: m.runtimeId,
      runId: m.runId,
      manifestDigest: sha(raw),
      verificationMode: m.verification?.mode,
      policyDigest: m.verification && sha(JSON.stringify(m.verification)),
      headSha,
      clean: true,
      command: 'true',
      args: [],
      success: true,
      exitCode: 0,
      diagnostic: '',
      at: new Date().toISOString(),
      ...fields,
    })}\n`,
  );
}

itNeedsCargo(
  'a scoped review needs a scoped check; a local CI receipt alone does not satisfy it (R-G4)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const review = (kind: string) => {
      f.backend.replyForRequest = (request) => {
        appendReceipt(request, { kind });
        return { resultText: scopeReport(f.state, f.tree.executionScope!) };
      };
      return runToFinish(f.state, f.tree.id, { role: 'review' });
    };
    const ciOnly = await review('local-ci');
    const environment = f.state.context.storage.runtimeEvidence.run(f.state.workspaceId, ciOnly);
    expect(
      (JSON.parse(readFileSync(environment!.manifestPath, 'utf8')) as PinnedCargoManifest)
        .verification?.mode,
    ).toBe('scoped-checks');
    expect(() => f.svc.assertRun(f.tree, ciOnly)).toThrow('ct-check --declared fixture');
  },
);

itNeedsCargo(
  'the brief names each adopted check and the command that runs it, which the gate needs (LIVE-23, R-G13)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'fixture', argv: ['git', 'diff', '--check', 'HEAD'], definitionPaths: [] },
      { id: 'lint', argv: ['git', 'status'], definitionPaths: [] },
    ]);
    let prompt = '';
    f.backend.replyForRequest = (request) => {
      prompt = request.prompt;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    await runToFinish(f.state, f.tree.id, { role: 'review' });
    const bin = /Use the controller Cargo launcher (\S+)\/cargo/.exec(prompt)?.[1];
    expect(bin).toBeTruthy();
    expect(prompt).toContain(`${bin}/ct-check --declared fixture`);
    expect(prompt).toContain(`${bin}/ct-check --declared lint`);
    // Daemon-run builds use their own build directory; CARGO_TARGET_DIR is the agent's (LIVE-26).
    expect(prompt).toContain(
      "Builds and checks CraftingTable runs for you (the Cargo launcher's builds, ct-check, ct-act, ct-native) use a build directory CraftingTable chooses, and the launcher's other Cargo commands use the manifest's (the run’s scratch/target)",
    );
    // The earlier section says the same, so the two do not contradict each other.
    if (prompt.includes('this worktree’s build cache'))
      expect(prompt).toContain(
        'The supplied Cargo launcher and CraftingTable’s checks use their own build directories instead',
      );
    // A reviewer runs them read-only on the reviewed head, and is not told to commit.
    expect(prompt).toContain("this review's gate needs a successful run of EACH");
    expect(prompt).not.toContain('After committing');
    expect(prompt).toContain('The adopted checks below are required');
    // An implementing run uses them early; a design run changes nothing and is told nothing.
    for (const role of ['implement', 'design'] as const) {
      await runToFinish(f.state, f.tree.id, { role });
      if (role === 'implement') {
        expect(prompt).toContain('After committing, run them to check your work early');
        expect(prompt).not.toContain("this review's gate needs");
      } else expect(prompt).not.toContain('ct-check --declared');
    }
  },
);

itNeedsCargo(
  "the daemon runs a review's adopted checks before the reviewer starts, and they meet the gate without the agent (R-G13 increment 3, LIVE-23)",
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'fixture', argv: ['git', 'diff', '--check', 'HEAD'], definitionPaths: [] },
      {
        id: 'broken',
        argv: ['git', 'rev-parse', '--verify', 'refs/heads/no-such-branch'],
        definitionPaths: [],
      },
    ]);
    const storage = f.state.context.storage;
    let prompt = '';
    let receiptsAtLaunch = -1;
    f.backend.replyForRequest = (request) => {
      prompt = request.prompt;
      receiptsAtLaunch = storage.runtimeEvidence.checkReceipts(
        f.state.workspaceId,
        request.environment?.CRAFTINGTABLE_RUN_NAMESPACE ?? '',
      ).length;
      // The reviewer runs nothing itself.
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    // Both ran, and were recorded, before the reviewer started.
    expect(receiptsAtLaunch).toBe(2);
    const receipts = storage.runtimeEvidence
      .checkReceipts(f.state.workspaceId, run)
      .map((r) => JSON.parse(r.receipt));
    expect(receipts.map((r) => [r.declaredCheck?.id, r.origin, r.success]).sort()).toEqual([
      ['broken', 'daemon', false],
      ['fixture', 'daemon', true],
    ]);
    expect(prompt).toContain(
      'Adopted checks CraftingTable ran on the reviewed head before this review:',
    );
    expect(prompt).toContain('- fixture: passed.');
    const failed = /- broken: failed \(exit \d+\)\..* Output: (\S+)/.exec(prompt);
    expect(failed).toBeTruthy();
    expect(existsSync(failed![1]!)).toBe(true);
    // The failure is the gate's, not a missing run: only the broken check is still owed.
    expect(() => f.svc.assertRun(f.tree, run)).toThrow('ct-check --declared broken.');
  },
);

itNeedsCargo(
  "a review's checks run in the background: its start returns at once, and a drain during them starts no agent (R-G13 increment 3)",
  async () => {
    const f = await scopedRuntimeFixture([
      {
        id: 'slow',
        argv: ['node', '-e', 'setTimeout(() => {}, 1500)'],
        definitionPaths: [],
      },
    ]);
    const storage = f.state.context.storage;
    const launched = () => f.backend.launches.length;
    const before = launched();
    const start = async () => {
      const response = await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
        headers: mutationHeaders(f.state),
        payload: { worktreeId: f.tree.id, role: 'review' },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().run.id as string;
    };
    // The request answers while the check still runs; the run is starting.
    const first = await start();
    expect(storage.execution.runs.find(f.state.workspaceId, first as never)?.status).toBe(
      'starting',
    );
    expect(launched()).toBe(before);
    await waitFor(
      () => storage.execution.runs.find(f.state.workspaceId, first as never)?.status === 'waiting',
      'the reviewer started after its check',
    );
    expect(launched()).toBe(before + 1);
    expect(storage.runtimeEvidence.checkReceipts(f.state.workspaceId, first)).toHaveLength(1);
    await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/runs/${first}/end`,
      headers: mutationHeaders(f.state),
      payload: {},
    });
    await waitFor(
      () => storage.execution.runs.find(f.state.workspaceId, first as never)?.status === 'finished',
      'finish',
    );
    // A restart drain during the checks cancels them and starts no reviewer.
    const second = await start();
    await f.state.context.services.agentRunService.interruptForRestart();
    await waitFor(
      () =>
        storage.execution.runs.find(f.state.workspaceId, second as never)?.status === 'interrupted',
      'the drain interrupted the starting review',
    );
    expect(launched()).toBe(before + 1);
  },
);

itNeedsCargo(
  'a receipt an agent writes to the launcher file satisfies no gate; the daemon runs and records the check (R-G4, SEC-01)',
  async () => {
    // The check reports where it ran; the launcher only relays the daemon's output.
    const f = await scopedRuntimeFixture([
      {
        id: 'where',
        argv: [
          'node',
          '-e',
          'console.log("checked in", process.cwd(), "agent", process.env.CT_AGENT_ONLY ?? "absent", "cargo", process.env.CARGO_HOME, "target", process.env.CARGO_TARGET_DIR)',
        ],
        definitionPaths: [],
      },
    ]);
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    f.backend.replyForRequest = (request) => {
      // Every kind the daemon runs, written by the agent instead.
      for (const kind of ['scoped-check', 'local-ci', 'native-check', undefined])
        appendReceipt(request, { kind, recordedBy: 'daemon' });
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const forged = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(storage.runtimeEvidence.run(f.state.workspaceId, forged)?.receiptAuthority).toBe(
      'daemon',
    );
    expect(storage.runtimeEvidence.build(f.state.workspaceId, forged)?.receipts).toBe('');
    expect(() => f.svc.assertRun(f.tree, forged)).toThrow('ct-check --declared where');

    let output = '';
    f.backend.replyForRequest = async (request) => {
      output = (await runLauncher(request, 'ct-check', ['--declared', 'where'])).stdout;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    process.env.CT_AGENT_ONLY = 'inherited';
    let checked: string;
    try {
      checked = await runToFinish(f.state, f.tree.id, { role: 'review' });
    } finally {
      delete process.env.CT_AGENT_ONLY;
    }
    // It runs in a private clone of the reviewed commit, never the agent's worktree, with a
    // fresh Cargo home of its own made from the daemon's downloads, never the operator's or the
    // shared one (R-G5 review; R-G13 review, operator decision 2026-09-29), and build outputs
    // that are the daemon's, one directory per reviewed commit.

    const { checkLogRoot } = f.state.context.config.execution;
    const head = git(['rev-parse', 'HEAD'], f.tree.path).trim();
    const location = new RegExp(
      `checked in ${checkLogRoot}/${checked}/([^/ ]+)\\.private/tree agent absent cargo ${checkLogRoot}/${checked}/cargo-home-0 target ${checkLogRoot}/${checked}/declared-target/${head}`,
    ).exec(output);
    expect(location, output).not.toBeNull();
    // The daemon names the clone's directory, never the request.
    const replies = readdirSync(join(checkLogRoot, checked, 'replies'));
    expect(replies.some((name) => name.startsWith(location![1]!))).toBe(false);
    // Once the run's checks close, the clones and build outputs are gone; the logs stay.
    const kept = readdirSync(join(checkLogRoot, checked));
    expect(
      kept.filter(
        (name) =>
          name === 'declared-target' || name.endsWith('.private') || name.startsWith('cargo-home-'),
      ),
    ).toEqual([]);
    expect(kept.some((name) => name.endsWith('.log'))).toBe(true);
    const [recorded] = storage.runtimeEvidence.checkReceipts(f.state.workspaceId, checked);
    expect(JSON.parse(recorded!.receipt)).toMatchObject({
      kind: 'scoped-check',
      recordedBy: 'daemon',
      success: true,
      clean: true,
      headSha: git(['rev-parse', 'HEAD'], f.tree.path).trim(),
      declaredCheck: { id: 'where' },
    });
    expect(() => f.svc.assertRun(f.tree, checked)).not.toThrow();
  },
);

itNeedsCargo(
  'a check still running when its run ends is stopped and records nothing (R-G4)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    let pending: Promise<unknown> | undefined;
    f.backend.replyForRequest = (request) => {
      // Not awaited: the agent ends its turn while its check is still running.
      pending = runLauncher(request, 'ct-check', [
        '--',
        process.execPath,
        '-e',
        'setTimeout(() => console.log("finished late"), 60000)',
      ]).then(
        () => 0,
        (error: { code?: number }) => error.code,
      );
      const checks = f.state.context.services.checkRequestService;
      const runId = request.buildEnvironment!.namespace!;
      // The turn ends once the daemon is running the check.
      const release = (async () => {
        while (checks.inFlight(runId).length === 0) await new Promise((r) => setTimeout(r, 20));
      })();
      return { resultText: scopeReport(f.state, f.tree.executionScope!), release };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(await pending).not.toBe(0);
    expect(storage.runtimeEvidence.checkReceipts(f.state.workspaceId, run)).toEqual([]);
    expect(storage.runtimeEvidence.build(f.state.workspaceId, run)?.receipts).toBe('');
  },
);

/** An operator local CI configuration whose act prints and then sleeps for `seconds`. */
function fakeLocalCi(root: string, seconds: number) {
  const tool = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const config = join(root, 'act.json');
  writeFileSync(
    config,
    JSON.stringify({
      actExecutable: tool('act', `echo "act ran"; sleep ${seconds}`),
      dockerExecutable: tool('docker', 'exit 0'),
      dockerHost: 'unix:///run/user/1000/docker.sock',
      image: `image@sha256:${'a'.repeat(64)}`,
      cacheRoot: join(root, 'cache'),
    }),
  );
  return config;
}

itNeedsCargo(
  'ct-act runs in the daemon; a local CI line an agent writes is dropped, and CI still running at the end invalidates the record (R-G4, LIVE-03)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    const root = mkdtempSync(join(tmpdir(), 'ct-receipt-gates-ci-'));
    mkdirSync(join(f.tree.path, '.github/workflows'), { recursive: true });
    writeFileSync(join(f.tree.path, '.github/workflows/ci.yml'), 'name: CI\non: push\n');
    git(['add', '.'], f.tree.path);
    git(['commit', '-m', 'workflow'], f.tree.path);
    const previous = process.env.CRAFTINGTABLE_ACT_CONFIG;
    process.env.CRAFTINGTABLE_ACT_CONFIG = fakeLocalCi(root, 0);
    try {
      let output = '';
      f.backend.replyForRequest = async (request) => {
        appendReceipt(request, { kind: 'local-ci' });
        output = (await runLauncher(request, 'ct-act', ['-W', '.github/workflows/ci.yml'])).stdout;
        return { resultText: scopeReport(f.state, f.tree.executionScope!) };
      };
      const ran = await runToFinish(f.state, f.tree.id, { role: 'review' });
      expect(output).toContain('act ran');
      const frozen = storage.runtimeEvidence.build(f.state.workspaceId, ran)!.receipts;
      // Only the daemon's own receipt: the appended line is gone.
      expect(
        frozen
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      ).toEqual([
        expect.objectContaining({ kind: 'local-ci', recordedBy: 'daemon', success: true }),
      ]);

      process.env.CRAFTINGTABLE_ACT_CONFIG = fakeLocalCi(root, 60);
      f.backend.replyForRequest = (request) => {
        void runLauncher(request, 'ct-act', ['-W', '.github/workflows/ci.yml']).catch(() => {});
        const checks = f.state.context.services.checkRequestService;
        const runId = request.buildEnvironment!.namespace!;
        const release = (async () => {
          while (!checks.inFlight(runId).includes('ct-act'))
            await new Promise((r) => setTimeout(r, 20));
        })();
        return { resultText: scopeReport(f.state, f.tree.executionScope!), release };
      };
      const unfinished = await runToFinish(f.state, f.tree.id, { role: 'review' });
      expect(storage.runtimeEvidence.build(f.state.workspaceId, unfinished)?.error).toContain(
        'Local CI did not finish collection',
      );
    } finally {
      if (previous === undefined) delete process.env.CRAFTINGTABLE_ACT_CONFIG;
      else process.env.CRAFTINGTABLE_ACT_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

itNeedsCargo(
  'the daemon uses the manifest it verified at launch; a rewritten copy changes nothing (R-G4)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    f.backend.replyForRequest = async (request) => {
      const manifest = join(request.buildEnvironment!.binDirectory, '../manifest.json');
      chmodSync(manifest, 0o600);
      writeFileSync(manifest, '{"workspacePath":"/","cargoExecutable":"/bin/false"}');
      await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    const build = storage.runtimeEvidence.build(f.state.workspaceId, run)!;
    expect(build.error).toBeUndefined();
    expect(JSON.parse(build.receipts)).toMatchObject({ success: true, recordedBy: 'daemon' });
    expect(() => f.svc.assertRun(f.tree, run)).not.toThrow();
  },
);

itNeedsCargo(
  'the daemon runs at most four checks of a run at once and refuses more than 32 waiting (R-G4 review)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const checks = f.state.context.services.checkRequestService;
    let peak = 0;
    let replies = '';
    f.backend.replyForRequest = (request) => {
      const runId = request.buildEnvironment!.namespace!;
      const spool = join(request.buildEnvironment!.binDirectory, '../requests');
      replies = join(f.state.context.config.execution.checkLogRoot, runId, 'replies');
      // Forty requests at once, written as a launcher would.
      for (let i = 0; i < 40; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        writeFileSync(
          join(spool, `${id}.request`),
          JSON.stringify({
            version: 1,
            tool: 'ct-check',
            args: ['--', process.execPath, '-e', 'setTimeout(() => {}, 200)'],
          }),
        );
      }
      const release = (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          peak = Math.max(peak, checks.inFlight(runId).length);
          let exits = 0;
          try {
            exits = readdirSync(replies).filter((n) => n.endsWith('.exit')).length;
          } catch {
            return; // The test has finished and removed its files.
          }
          if (exits === 40) return;
          await new Promise((r) => setTimeout(r, 10));
        }
      })();
      return { resultText: scopeReport(f.state, f.tree.executionScope!), release };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    const exits = readdirSync(replies)
      .filter((n) => n.endsWith('.exit'))
      .map((n) => JSON.parse(readFileSync(join(replies, n), 'utf8')));
    // Never more than four at once; under load fewer may overlap, but more than one always do.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(exits.filter((e) => e.diagnostic?.includes('Too many checks'))).toHaveLength(4);
    expect(exits.filter((e) => e.exitCode === 0)).toHaveLength(36);
    expect(
      f.state.context.storage.runtimeEvidence.checkReceipts(f.state.workspaceId, run),
    ).toHaveLength(36);
  },
  90_000,
);

itNeedsCargo(
  'a daemon-recorded run that ends has its labelled CI containers removed, even with no CI check running (R-G4 review)',
  async () => {
    const f = await scopedRuntimeFixture();
    const root = mkdtempSync(join(tmpdir(), 'ct-receipt-gates-cleanup-'));
    const calls = join(root, 'docker.log');
    const config = join(root, 'act.json');
    const tool = (name: string, body: string) => {
      writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      return join(root, name);
    };
    writeFileSync(
      config,
      JSON.stringify({
        actExecutable: tool('act', 'exit 0'),
        dockerExecutable: tool('docker', `echo "$@" >> ${calls}; exit 0`),
        dockerHost: 'unix:///run/user/1000/docker.sock',
        image: `image@sha256:${'a'.repeat(64)}`,
        cacheRoot: join(root, 'cache'),
      }),
    );
    const previous = process.env.CRAFTINGTABLE_ACT_CONFIG;
    process.env.CRAFTINGTABLE_ACT_CONFIG = config;
    try {
      f.backend.replyForRequest = () => ({
        resultText: scopeReport(f.state, f.tree.executionScope!),
      });
      const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
      const deadline = Date.now() + 10_000;
      while (!existsSync(calls) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      expect(readFileSync(calls, 'utf8')).toContain(
        `ps -aq --filter label=craftingtable.run=${run}`,
      );
    } finally {
      if (previous === undefined) delete process.env.CRAFTINGTABLE_ACT_CONFIG;
      else process.env.CRAFTINGTABLE_ACT_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

itNeedsCargo(
  'only the adopted check meets a scoped gate: a command the agent chooses is supplemental, even the same one, and the agent cannot change what the check runs (R-G13)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const storage = f.state.context.storage;
    const failures: string[] = [];
    f.backend.replyForRequest = async (request) => {
      // The adopted command, but chosen by the agent: it runs and is recorded, and counts for nothing.
      await runLauncher(request, 'ct-check', ['--', 'git', 'diff', '--check', 'HEAD']);
      await runLauncher(request, 'ct-check', ['--', 'true']);
      for (const args of [
        ['--declared', 'fixture', '--', 'true'],
        ['--declared', 'other'],
        ['--declared'],
      ])
        failures.push(
          await runLauncher(request, 'ct-check', args).then(
            () => 'ran',
            (error: { stdout: string; stderr: string }) => error.stdout + error.stderr,
          ),
        );
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const chosen = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(failures[0]).toContain('Usage: ct-check --declared <check>');
    expect(failures[1]).toContain('other is not a declared check of this repository');
    expect(failures[1]).toContain('Declared: fixture');
    expect(failures[2]).toContain('Usage: ct-check --declared <check>');
    const receipts = storage.runtimeEvidence
      .checkReceipts(f.state.workspaceId, chosen)
      .map((r) => JSON.parse(r.receipt));
    expect(receipts.filter((r) => r.success)).toHaveLength(2);
    expect(receipts.some((r) => r.declaredCheck)).toBe(false);
    expect(() => f.svc.assertRun(f.tree, chosen)).toThrow(
      'The review needs a successful run of each declared check on its exact clean reviewed commit: ct-check --declared fixture.',
    );

    f.backend.replyForRequest = async (request) => {
      await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const declared = await runToFinish(f.state, f.tree.id, { role: 'review' });
    const environment = storage.runtimeEvidence.run(f.state.workspaceId, declared)!;
    const adopted = storage.runtimeEvidence.checkDeclarations(
      f.state.workspaceId,
      f.tree.repositoryId,
    )[0]!;
    // The run was held to the adoption current when it was prepared.
    expect(environment.checkDeclarationId).toBe(adopted.id);
    const [receipt] = storage.runtimeEvidence.checkReceipts(f.state.workspaceId, declared);
    expect(JSON.parse(receipt!.receipt)).toMatchObject({
      command: 'git',
      args: ['--declared', 'fixture'],
      success: true,
      declaredCheck: { id: 'fixture', declarationId: adopted.id, definitionDigests: {} },
    });
    expect(() => f.svc.assertRun(f.tree, declared)).not.toThrow();
  },
);

itNeedsCargo(
  'a declared check whose definition the slice edited stops as check-definition-changed until the edit is adopted or reverted (R-G13)',
  async () => {
    const adopted = '#!/bin/sh\necho adopted check\n';
    const f = await scopedRuntimeFixture(
      [{ id: 'script', argv: ['scripts/check.sh'], definitionPaths: ['scripts/check.sh'] }],
      { 'scripts/check.sh': sha(adopted) },
    );
    const commitScript = (content: string) => {
      mkdirSync(join(f.tree.path, 'scripts'), { recursive: true });
      writeFileSync(join(f.tree.path, 'scripts/check.sh'), content, { mode: 0o755 });
      chmodSync(join(f.tree.path, 'scripts/check.sh'), 0o755);
      git(['add', 'scripts/check.sh'], f.tree.path);
      git(['commit', '-m', 'check script'], f.tree.path);
    };
    let output = '';
    f.backend.replyForRequest = async (request) => {
      output = (await runLauncher(request, 'ct-check', ['--declared', 'script'])).stdout;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    commitScript(adopted);
    const same = await runToFinish(f.state, f.tree.id, { role: 'review' });
    // The repository's own program runs from the worktree under review.
    expect(output).toContain('adopted check');
    const [receipt] = f.state.context.storage.runtimeEvidence.checkReceipts(
      f.state.workspaceId,
      same,
    );
    expect(JSON.parse(receipt!.receipt).command).toMatch(
      new RegExp(
        `^${f.state.context.config.execution.checkLogRoot}/${same}/[^/]+\\.private/tree/scripts/check\\.sh$`,
      ),
    );
    expect(() => f.svc.assertRun(f.tree, same)).not.toThrow();

    // The slice rewrites the check so it passes whatever it does.
    commitScript('#!/bin/sh\necho weakened check\n');
    const edited = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(output).toContain('weakened check');
    expect(() => f.svc.assertRun(f.tree, edited)).toThrow(CheckDefinitionChangedError);
    expect(() => f.svc.assertRun(f.tree, edited)).toThrow(
      'The declared check script ran with definitions that differ from the adopted ones (scripts/check.sh).',
    );
    try {
      f.svc.assertRun(f.tree, edited);
    } catch (error) {
      expect(error).toMatchObject({ repositoryId: f.tree.repositoryId, checkId: 'script' });
    }

    // Restoring the adopted file in the worktree, hidden from Git, does not hide the commit's.
    writeFileSync(join(f.tree.path, 'scripts/check.sh'), adopted, { mode: 0o755 });
    git(['update-index', '--skip-worktree', 'scripts/check.sh'], f.tree.path);
    const hidden = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(() => f.svc.assertRun(f.tree, hidden)).toThrow(CheckDefinitionChangedError);
    git(['update-index', '--no-skip-worktree', 'scripts/check.sh'], f.tree.path);
    git(['checkout', '--', 'scripts/check.sh'], f.tree.path);

    // A definition replaced by a link is not the adopted file either.
    rmSync(join(f.tree.path, 'scripts/check.sh'));
    writeFileSync(join(f.tree.path, 'scripts/real.sh'), adopted, { mode: 0o755 });
    execFileSync('ln', ['-s', 'real.sh', join(f.tree.path, 'scripts/check.sh')]);
    git(['add', '-A', 'scripts'], f.tree.path);
    git(['commit', '-m', 'linked check'], f.tree.path);
    const linked = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(output).toContain('adopted check');
    expect(() => f.svc.assertRun(f.tree, linked)).toThrow(CheckDefinitionChangedError);
  },
);

itNeedsCargo(
  'a scoped slice in a repository with no adopted checks stops before any run as repository-checks-undeclared (R-G13, fail closed)',
  async () => {
    const f = await scopedRuntimeFixture(null);
    const cycle = await startCycle(f.state, f.tree.id);
    await waitFor(() => currentCycle(f.state, cycle).status === 'needs-attention', 'check stop');
    expect(currentCycle(f.state, cycle).attention).toMatchObject({
      code: 'repository-checks-undeclared',
      owner: 'operator',
      refs: { repositoryId: f.tree.repositoryId },
    });
    expect(currentCycle(f.state, cycle).reason).toContain('has no adopted checks');
    expect(f.backend.launches).toHaveLength(0);
    // Its item opens the repository's checks, where they are adopted.
    const item = f.state.context.storage.attention
      .open(f.state.workspaceId)
      .find((i) => i.subjectKey === `cycle:${cycle.id}`);
    expect(item).toMatchObject({
      code: 'repository-checks-undeclared',
      path: `/workspaces/${f.state.workspaceId}/repositories#repository-checks-${f.tree.repositoryId}`,
    });
  },
);

itNeedsCargo(
  'a declared check never runs a program the agent planted on the run PATH (R-G13 review)',
  async () => {
    const f = await scopedRuntimeFixture();
    let output = '';
    f.backend.replyForRequest = async (request) => {
      // The launchers' directory is in the run directory, which the agent can write.
      const bin = request.buildEnvironment!.binDirectory;
      chmodSync(bin, 0o700);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\necho PLANTED "$@"\nexit 0\n', { mode: 0o755 });
      output = (await runLauncher(request, 'ct-check', ['--declared', 'fixture'])).stdout;
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(output).not.toContain('PLANTED');
    const [receipt] = f.state.context.storage.runtimeEvidence.checkReceipts(
      f.state.workspaceId,
      run,
    );
    expect(JSON.parse(receipt!.receipt)).toMatchObject({ success: true, command: 'git' });
    expect(() => f.svc.assertRun(f.tree, run)).not.toThrow();
  },
);

itNeedsCargo(
  'a declared check runs on the reviewed commit: what the agent writes in its worktree, even hidden from Git, does not reach it (R-G13 review)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'result', argv: ['grep', '-q', 'ok', 'result.txt'], definitionPaths: [] },
    ]);
    commitFile(f.tree.path, 'result.txt', 'fail');
    let exit: number | undefined;
    f.backend.replyForRequest = async (request) => {
      writeFileSync(join(request.cwd, 'result.txt'), 'ok');
      git(['update-index', '--skip-worktree', 'result.txt'], request.cwd);
      exit = await runLauncher(request, 'ct-check', ['--declared', 'result']).then(
        () => 0,
        (error: { code?: number }) => error.code,
      );
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(exit).not.toBe(0);
    const [receipt] = f.state.context.storage.runtimeEvidence.checkReceipts(
      f.state.workspaceId,
      run,
    );
    expect(JSON.parse(receipt!.receipt)).toMatchObject({ success: false });
    expect(() => f.svc.assertRun(f.tree, run)).toThrow('ct-check --declared result');
  },
);

itNeedsCargo(
  'a declared check counts only when the worktree was clean and still at the reviewed commit (R-G13 review)',
  async () => {
    const f = await scopedRuntimeFixture();
    // The agent's own requests: the daemon's runs before a review are tested on their own.
    withoutDaemonChecks(f.state);
    const review = (after: (cwd: string) => void, before?: (cwd: string) => void) => {
      f.backend.replyForRequest = async (request) => {
        before?.(request.cwd);
        await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
        after(request.cwd);
        return { resultText: scopeReport(f.state, f.tree.executionScope!) };
      };
      return runToFinish(f.state, f.tree.id, { role: 'review' });
    };
    // An untracked file while the check ran.
    const dirty = await review(
      (cwd) => rmSync(join(cwd, 'notes.txt')),
      (cwd) => writeFileSync(join(cwd, 'notes.txt'), 'scratch'),
    );
    expect(() => f.svc.assertRun(f.tree, dirty)).toThrow('ct-check --declared fixture');
    // A commit before the check: it ran on a commit other than the one under review.
    const moved = await review(
      () => {},
      (cwd) => commitFile(cwd, 'later.txt', 'not the reviewed commit'),
    );
    expect(() => f.svc.assertRun(f.tree, moved)).toThrow('ct-check --declared fixture');
    const clean = await review(() => {});
    expect(() => f.svc.assertRun(f.tree, clean)).not.toThrow();
  },
);

itNeedsCargo(
  'check-definition-changed stops the cycle, and adopting the new definition then resuming passes a fresh review (R-G13 review)',
  { timeout: 30000 },
  async () => {
    const adopted = '#!/bin/sh\necho adopted check\n';
    const weakened = '#!/bin/sh\necho weakened check\n';
    const f = await scopedRuntimeFixture(
      [{ id: 'script', argv: ['scripts/check.sh'], definitionPaths: ['scripts/check.sh'] }],
      { 'scripts/check.sh': sha(adopted) },
    );
    const commitScript = (cwd: string, content: string) => {
      mkdirSync(join(cwd, 'scripts'), { recursive: true });
      writeFileSync(join(cwd, 'scripts/check.sh'), content, { mode: 0o755 });
      git(['add', 'scripts/check.sh'], cwd);
      git(['commit', '-m', 'check script'], cwd);
    };
    commitScript(f.tree.path, adopted);
    f.backend.replyForRequest = async (request) => {
      if (request.model === 'design-model') return designDone;
      if (request.model !== 'review-model') {
        commitScript(request.cwd, weakened);
        return implementationDone;
      }
      await runLauncher(request, 'ct-check', ['--declared', 'script']);
      return {
        resultText: `## Open questions\nnone\n\n## Review report\n${scopeReport(f.state, f.tree.executionScope!)}`,
      };
    };
    const cycle = await startCycle(f.state, f.tree.id);
    await waitFor(
      () => currentCycle(f.state, cycle).status === 'needs-attention',
      'definition stop',
      20000,
    );
    const stopped = currentCycle(f.state, cycle);
    expect(stopped.attention).toMatchObject({
      code: 'check-definition-changed',
      owner: 'operator',
      refs: { repositoryId: f.tree.repositoryId, checkId: 'script' },
    });
    expect(stopped.reason).toContain('then resume for a fresh review');
    const item = f.state.context.storage.attention
      .open(f.state.workspaceId)
      .find((i) => i.subjectKey === `cycle:${cycle.id}`);
    expect(item?.path).toBe(
      `/workspaces/${f.state.workspaceId}/repositories#repository-checks-${f.tree.repositoryId}`,
    );
    // The operator adopts the edited definition, as the Repositories page would.
    const storage = f.state.context.storage;
    const current = storage.runtimeEvidence.checkDeclarations(
      f.state.workspaceId,
      f.tree.repositoryId,
    )[0]!;
    storage.runtimeEvidence.addCheckDeclaration({
      ...current,
      id: randomUUID(),
      version: 2,
      definitionDigests: { 'scripts/check.sh': sha(weakened) },
      rationale: 'The slice improved the check.',
    });
    // The stopped review ran exactly what is now adopted, so it would merge as it is.
    expect(() => f.svc.assertRun(f.tree, stopped.currentRunId!)).not.toThrow();
    await controlCycle(f.state, stopped, 'resume');
    await waitFor(
      () => currentCycle(f.state, cycle).status === 'awaiting-merge',
      'fresh review passes',
      20000,
    );
  },
);

itNeedsCargo(
  'a declared check refuses an object the agent rewrote in the shared store, which Git never re-hashes on read (R-G13 review)',
  async () => {
    const f = await scopedRuntimeFixture([
      { id: 'result', argv: ['grep', '-q', 'ok', 'result.txt'], definitionPaths: [] },
    ]);
    commitFile(f.tree.path, 'result.txt', 'fail');
    const common = git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      f.tree.path,
    ).trim();
    const blob = git(['rev-parse', 'HEAD:result.txt'], f.tree.path).trim();
    const object = join(common, 'objects', blob.slice(0, 2), blob.slice(2));
    const original = readFileSync(object);
    let exit: number | undefined;
    let said = '';
    f.backend.replyForRequest = async (request) => {
      // The loose object of the failing file now holds a passing one, under the same name.
      chmodSync(object, 0o644);
      writeFileSync(object, deflateSync(Buffer.from('blob 2\0ok')));
      exit = await runLauncher(request, 'ct-check', ['--declared', 'result']).then(
        () => 0,
        (error: { code?: number; stdout: string; stderr: string }) => {
          said = error.stdout + error.stderr;
          return error.code;
        },
      );
      writeFileSync(object, original);
      return { resultText: scopeReport(f.state, f.tree.executionScope!) };
    };
    const run = await runToFinish(f.state, f.tree.id, { role: 'review' });
    expect(exit).not.toBe(0);
    expect(said).toContain('could not be checked out');
    expect(() => f.svc.assertRun(f.tree, run)).toThrow('ct-check --declared result');
  },
);
