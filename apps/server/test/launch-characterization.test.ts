import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { type AgentLaunchRequest, RUN_ID_VARIABLE } from '@craftingtable/agents';
import type { AgentRunId, WorkspaceId } from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import {
  admit,
  adoptSupervisedMap,
  beginFinalization,
  branchCommand,
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  CycleBackend,
  cycleFixture,
  cycleProfiles,
  declareFixtureChecks,
  designDone,
  finalizationFixture,
  fixtureRepository,
  git,
  implementationDone,
  launchScoped,
  mutationHeaders,
  present,
  type Ready,
  ready,
  registerAndWorktree,
  reviewText,
  type ScriptedReply,
  scopeTree,
  slicedFixture,
  startCycle,
  storedRoadmap,
  stepDaemons,
  structuredFinding,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';
import { testDataRoot } from './test-support.js';

/**
 * R-B7's launch characterization (increment 1; program rule 3, characterize before refactoring).
 *
 * What each kind of launch writes and records today, pinned so the cycle half's moves can be
 * shown to change none of it: the brief and the prompt by digest, the run directory's files by
 * relative path and digest, the run row, its evidence records, its audit row and its workspace
 * event. Beside them, what a set of refused launches leave behind (AGT-12's orphans), which
 * increment 11b's reservation changes and lists. Paths, ids, digests, temporary names and times
 * are normalized before hashing, as the replays' `(minted)` ids are, so the record is the same on
 * every machine and every run.
 *
 * The record is `fixtures/launch-characterization.json`. `UPDATE_LAUNCH_CHARACTERIZATION=1`
 * rewrites the entries of the cases that run; a difference fails with each case's normalized
 * texts written under `$TMPDIR/launch-characterization/` for comparison.
 */

const SOURCE = join(import.meta.dirname, '../../..');
const RECORD = join(SOURCE, 'fixtures/launch-characterization.json');
const UPDATE = process.env.UPDATE_LAUNCH_CHARACTERIZATION === '1';
const DUMP = join(tmpdir(), 'launch-characterization');

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const recorded: Record<string, Json> = existsSync(RECORD)
  ? (JSON.parse(readFileSync(RECORD, 'utf8')) as Record<string, Json>)
  : {};
const observed: Record<string, Json> = {};

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});
afterAll(() => {
  if (!UPDATE) return;
  const merged = { ...recorded, ...observed };
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((key) => [key, merged[key]!]),
  );
  writeFileSync(RECORD, `${JSON.stringify(sorted, null, 2)}\n`);
});

const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/**
 * Replaces what differs between runs and machines with stable names: the fixture's directories
 * by role, then ids, digests and commits numbered by first appearance, then times. One
 * normalizer serves one case, so a name means the same value across its texts.
 */
class Normalizer {
  private readonly names = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  constructor(private readonly roots: readonly (readonly [string, string])[]) {}

  private name(kind: string, value: string): string {
    const known = this.names.get(value);
    if (known) return known;
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const named = `<${kind}:${n}>`;
    this.names.set(value, named);
    return named;
  }

  text(input: string): string {
    let text = input;
    for (const [path, label] of [...this.roots].sort((a, b) => b[0].length - a[0].length))
      text = text.split(path).join(label);
    text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (value) =>
      this.name('uuid', value),
    );
    text = text.replace(/\b[0-9a-f]{64}\b/g, (value) => this.name('hex64', value));
    text = text.replace(/\b[0-9a-f]{40}\b/g, (value) => {
      const named = this.name('sha', value);
      // A commit is also cited by its first twelve or seven characters (Git's short form).
      this.names.set(value.slice(0, 12), `${named.slice(0, -1)}/12>`);
      this.names.set(value.slice(0, 7), `${named.slice(0, -1)}/7>`);
      return named;
    });
    // A run's process temporary directory has a random name (LIVE-31).
    text = text.replace(/<data>\/t\/[0-9a-f]{12}\b/g, '<data>/t/<process>');
    // A short commit cited before, or never, in full; a word of hex letters alone is prose.
    text = text.replace(/\b(?:[0-9a-f]{12}|[0-9a-f]{7})\b/g, (value) =>
      /\d/.test(value) ? (this.names.get(value) ?? this.name('short', value)) : value,
    );
    return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, '<time>');
  }

  value(input: unknown): Json {
    return JSON.parse(this.text(JSON.stringify(input ?? null))) as Json;
  }
}

/**
 * Every file under a directory: its relative path, and its digest or a link's target, with its
 * permission bits.
 */
function tree(root: string, normalizer: Normalizer, dump?: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const key = normalizer.text(relative(root, path));
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isDirectory()) {
        files[`${key}/`] = `directory ${mode}`;
        walk(path);
      } else if (stat.isSymbolicLink()) files[key] = `link ${normalizer.text(readlinkSync(path))}`;
      else {
        const text = normalizer.text(readFileSync(path, 'utf8'));
        files[key] = `${digest(text)} ${mode}`;
        if (dump) {
          mkdirSync(dirname(join(dump, key)), { recursive: true });
          writeFileSync(join(dump, key), text);
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}

/**
 * What is named differently on every run: the fixture's directories, by role, and each
 * worktree branch's random suffix, numbered in the order the worktrees were made.
 */
function rootsOf(state: Ready, extra: readonly (readonly [string, string])[] = []) {
  const database = openDatabase(state.context.storage.databasePath);
  let suffixes: string[];
  try {
    suffixes = (
      database.prepare('SELECT branch_name FROM worktrees ORDER BY created_at, rowid').all() as {
        branch_name: string;
      }[]
    ).flatMap(({ branch_name }) => /-([0-9a-f]{8})$/.exec(branch_name)?.slice(1) ?? []);
  } finally {
    database.close();
  }
  return [
    [state.context.directory, '<data>'],
    [testDataRoot(), '<test-data>'],
    [tmpdir(), '<tmp>'],
    [SOURCE, '<source>'],
    ...extra,
    ...suffixes.map((suffix, i) => [suffix, `<branch-suffix:${i + 1}>`] as const),
  ] as const;
}

/**
 * One launch as the agent is started: everything before the spawn is written and recorded by
 * then (the backend's launch is the spawn).
 */
function captureLaunch(
  state: Ready,
  request: AgentLaunchRequest,
  extraRoots: readonly (readonly [string, string])[] = [],
  label = 'launch',
): Json {
  const runId = request.environment?.[RUN_ID_VARIABLE] as AgentRunId | undefined;
  if (!runId) throw new Error('The launch names no run');
  const storage = state.context.storage;
  const workspaceId = state.workspaceId as WorkspaceId;
  const normalizer = new Normalizer(rootsOf(state, extraRoots));
  const run = storage.execution.runs.find(workspaceId, runId);
  if (!run) throw new Error('The launch has no run row');
  const dump = join(DUMP, label);
  rmSync(dump, { recursive: true, force: true });
  mkdirSync(dump, { recursive: true });
  const brief = normalizer.text(run.brief ?? '');
  const prompt = normalizer.text(request.prompt);
  writeFileSync(join(dump, 'BRIEF.md'), brief);
  writeFileSync(join(dump, 'PROMPT.md'), prompt);
  const runDirectory = join(state.context.config.execution.runsRoot, runId);
  const files = tree(runDirectory, normalizer, join(dump, 'run'));
  const { brief: _brief, ...row } = run;
  const { audit, events } = recordsOf(state, runId);
  const captured = {
    brief: digest(brief),
    prompt: digest(prompt),
    files,
    run: normalizer.value(row),
    evidence: normalizer.value(storage.runtimeEvidence.run(workspaceId, runId) ?? null),
    audit: normalizer.value(audit),
    event: normalizer.value(events),
    // What the backend is asked to start, the prompt aside.
    request: normalizer.value({ ...request, prompt: undefined }),
  };
  writeFileSync(join(dump, 'RECORD.json'), JSON.stringify(captured, null, 2));
  return captured as Json;
}

/** The run's audit row and workspace event, as stored (their sequence aside). */
function recordsOf(state: Ready, runId: AgentRunId) {
  const database = openDatabase(state.context.storage.databasePath);
  try {
    const rows = (sql: string) =>
      (database.prepare(sql).all(runId) as Record<string, unknown>[]).map(
        ({ sequence: _sequence, ...row }) => row,
      );
    return {
      audit: rows(
        `SELECT * FROM audit_events WHERE action = 'agent-run.start' AND target_id = ? ORDER BY sequence`,
      ),
      events: rows(
        `SELECT * FROM workspace_events WHERE kind = 'agent-run-started' AND run_id = ? ORDER BY sequence`,
      ),
    };
  } finally {
    database.close();
  }
}

/** Compares a case's captures with the record, or records them. */
function expectRecorded(key: string, value: Json): void {
  observed[key] = value;
  if (UPDATE) return;
  expect(
    recorded[key],
    `${key}: not in ${RECORD}; run with UPDATE_LAUNCH_CHARACTERIZATION=1 to record it`,
  ).toBeDefined();
  expect(value, `${key}: normalized texts in ${DUMP}`).toEqual(recorded[key]);
}

it("pins a cycle's design, implement, review, review continuation, remediate and second review launches (R-B7 increment 1)", async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree, root } = await cycleFixture(
    [
      designDone,
      implementationDone,
      // The first review stops while its background work runs: its continuation follows.
      { resultText: 'Waiting for the matrix.', exitReason: 'background-work-incomplete' },
      { resultText: reviewText([structuredFinding]) },
      implementationDone,
      { resultText: reviewText([]) },
    ],
    () => now,
  );
  const kinds = ['design', 'implement', 'review', 'review-continuation', 'remediate', 'review-2'];
  const captures: Record<string, Json> = {};
  const roots = [
    [worktree.path, '<worktree>'],
    [root, '<repository>'],
  ] as const;
  backend.onLaunch = (request) => {
    const kind = kinds[backend.launches.length] ?? `extra-${backend.launches.length}`;
    if (request.model === 'implement-model')
      commitFile(worktree.path, `step-${backend.launches.length}.txt`, `${kind}\n`);
    captures[kind] = captureLaunch(state, request, roots, `cycle-${kind}`);
  };
  const cycle = await startCycle(state, worktree.id, { instructions: 'Keep the scope.' });
  await waitFor(() => Object.keys(captures).length === kinds.length, 'the second review').catch(
    (error) => {
      console.log(JSON.stringify(currentCycle(state, cycle), null, 1).slice(0, 3000));
      throw error;
    },
  );
  expect(Object.keys(captures)).toEqual(kinds);
  for (const kind of kinds) expectRecorded(`cycle ${kind}`, captures[kind]!);
});

it('pins a manual run (R-B7 increment 1)', async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree, root } = await cycleFixture([implementationDone], () => now);
  let captured: Json | undefined;
  backend.onLaunch = (request) => {
    captured = captureLaunch(
      state,
      request,
      [
        [worktree.path, '<worktree>'],
        [root, '<repository>'],
      ],
      'manual',
    );
  };
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: {
      worktreeId: worktree.id,
      role: 'implement',
      permissionMode: 'auto',
      instructions: 'Make the queue drain.',
    },
  });
  expect(started.statusCode, started.body).toBe(200);
  expect(captured).toBeDefined();
  expectRecorded('manual implement', captured!);
});

/** The roots a cycle fixture's texts name. */
const fixtureRoots = (worktreePath: string, repository: string) =>
  [
    [worktreePath, '<worktree>'],
    [repository, '<repository>'],
  ] as const;

it("pins a cycle's launches in a repository with adopted checks: check-only manifests, and a review whose checks run first (R-B7 increment 1)", async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree, root } = await cycleFixture(
    [designDone, implementationDone, { resultText: reviewText([]) }],
    () => now,
  );
  declareFixtureChecks(state);
  const kinds = ['design', 'implement', 'review'];
  const captures: Record<string, Json> = {};
  backend.onLaunch = (request) => {
    const kind = kinds[backend.launches.length] ?? `extra-${backend.launches.length}`;
    if (request.model === 'implement-model') commitFile(worktree.path, 'work.txt', 'work\n');
    captures[kind] = captureLaunch(
      state,
      request,
      fixtureRoots(worktree.path, root),
      `checks-${kind}`,
    );
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => Object.keys(captures).length === kinds.length, 'the review');
  expect(currentCycle(state, cycle).step).toBe('review');
  for (const kind of kinds) expectRecorded(`checks ${kind}`, captures[kind]!);
});

it("pins a staged finalization's first stage launches (R-B7 increment 1)", async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const fixture = await finalizationFixture({ now: () => now });
  const { state, backend, root } = fixture;
  const captures: Json[] = [];
  const launched = backend.onLaunch;
  backend.onLaunch = (request) => {
    launched?.(request);
    if (captures.length >= 2) return;
    const tree = present(
      state.context.storage.execution.worktrees.find(
        state.workspaceId,
        present(
          state.context.storage.execution.runs.find(
            state.workspaceId,
            request.environment?.[RUN_ID_VARIABLE] as AgentRunId,
          ),
        ).worktreeId,
      ),
    );
    captures.push(
      captureLaunch(
        state,
        request,
        fixtureRoots(tree.path, root),
        `finalization-${captures.length}`,
      ),
    );
  };
  await beginFinalization(fixture);
  await waitFor(() => captures.length === 2, 'two stage launches');
  for (const [i, captured] of captures.entries())
    expectRecorded(`finalization stage launch ${i + 1}`, captured);
});

it('pins an integration resolution launch (R-B7 increment 1)', async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree, root } = await cycleFixture(
    [designDone, implementationDone, { resultText: reviewText([]) }],
    () => now,
  );
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(worktree.path, 'README.md', 'item behavior\n');
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'the approval');
  await controlCycle(state, currentCycle(state, cycle), 'pause');
  commitFile(root, 'README.md', 'integration behavior\n');
  const resolution = (input: Record<string, unknown>) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/integration-resolution`,
      headers: mutationHeaders(state),
      payload: { expectedVersion: currentCycle(state, cycle).version, ...input },
    });
  const inspected = await resolution({ action: 'inspect' });
  expect(inspected.statusCode, inspected.body).toBe(200);
  let captured: Json | undefined;
  backend.replyForRequest = () => ({
    resultText: 'Combined checks passed.\n\n## Resolution status\nready',
  });
  backend.onLaunch = (request) => {
    if (request.model !== 'resolution-model' || captured) return;
    captured = captureLaunch(state, request, fixtureRoots(worktree.path, root), 'resolution');
    writeFileSync(join(worktree.path, 'README.md'), 'both behaviors\n');
    git(['add', 'README.md'], worktree.path);
  };
  const started = await resolution({
    action: 'start',
    profile: { ...cycleProfiles.remediate, model: 'resolution-model' },
    instructions: 'Preserve both behaviors',
  });
  expect(started.statusCode, started.body).toBe(200);
  await waitFor(() => captured !== undefined, 'the resolution launch');
  expectRecorded('integration resolution', captured!);
});

it('pins a design recovery launch (R-B7 increment 1)', async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree, root } = await cycleFixture(
    [{ resultText: '## Open questions\nWhich storage format?' }, designDone],
    () => now,
  );
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
  const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
  const snapshot = (
    await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
  ).json();
  let captured: Json | undefined;
  backend.onLaunch = (request) => {
    captured ??= captureLaunch(state, request, fixtureRoots(worktree.path, root), 'recovery');
  };
  const launched = await state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(state),
    payload: {
      expectedVersion: snapshot.expectedVersion,
      snapshotDigest: snapshot.snapshotDigest,
      mode: 'continue',
      profile: { backend: 'claude-code', model: 'recovery-model' },
      instructions: 'Use SQLite; I own the storage decision.',
      attachments: [{ name: 'decision.md', content: 'Operator supplied storage decision.' }],
    },
  });
  expect(launched.statusCode, launched.body).toBe(200);
  await waitFor(() => captured !== undefined, 'the recovery launch');
  expectRecorded('design recovery', captured!);
});

it("pins a question stop's investigation launch (R-B7 increment 1)", async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree, root } = await cycleFixture([], () => now);
  let implementations = 0;
  backend.replyForRequest = (request) =>
    request.readOnly
      ? { resultText: 'Nothing settles it.' }
      : request.model === 'design-model'
        ? designDone
        : implementations++ === 0
          ? { resultText: 'Partly implemented.\n\n## Open questions\n- Which format?' }
          : implementationDone;
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).attention?.code === 'implementation-open-questions',
    'the question stop',
  );
  let captured: Json | undefined;
  backend.onLaunch = (request) => {
    if (request.readOnly)
      captured ??= captureLaunch(
        state,
        request,
        fixtureRoots(worktree.path, root),
        'investigation',
      );
  };
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/investigation`,
    headers: mutationHeaders(state),
    payload: { action: 'start', expectedVersion: currentCycle(state, cycle).version },
  });
  expect(started.statusCode, started.body).toBe(200);
  await waitFor(() => captured !== undefined, 'the investigation launch');
  expectRecorded('investigation', captured!);
});

it('pins a decision preparation launch (R-B7 increment 1)', async () => {
  const f = await supervisedMapFixture(false, 'automatic', false, false, false, (source) => ({
    ...source,
    evidence_profiles: [
      ...source.evidence_profiles,
      {
        id: 'architecture-approval',
        independence_required: true,
        reviewer_roles: ['repository-maintainer'],
        required_evidence: [
          'accepted decision artifact digest and revision',
          'source contract and affected schema or protocol references',
          'decision owner approval and applicability to the active plan generation',
        ],
      },
    ],
    checkpoints: [
      ...source.checkpoints,
      {
        ...source.checkpoints[0]!,
        id: 'LOCAL-ADR-01',
        owner: 'local',
        kind: 'architecture_decision' as const,
        evidence_profile: 'architecture-approval',
        requires: [],
      },
    ],
    slices: source.slices.map((slice) => ({
      ...slice,
      start_requires: [
        { kind: 'checkpoint' as const, id: 'LOCAL-ADR-01', state: 'passed' as const },
      ],
    })),
  }));
  f.backend.replyForRequest = () => ({ resultText: 'Nothing to prepare.' });
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, f.state.workspaceId, f.input).roadmap;
  let captured: Json | undefined;
  f.backend.onLaunch = (request) => {
    captured ??= captureLaunch(f.state, request, [[f.root, '<repository>']], 'preparation');
  };
  const prepared = await f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/roadmaps/${saved.id}/prepare-decision`,
    headers: mutationHeaders(f.state),
    payload: {
      expectedVersion: storedRoadmap(f.state).version,
      checkpointId: 'LOCAL-ADR-01',
      profile: { backend: 'claude-code', model: 'decision-model' },
      minutes: 5,
      instructions: 'Prefer the documented boundary.',
    },
  });
  expect(prepared.statusCode, prepared.body).toBe(200);
  await waitFor(() => captured !== undefined, 'the preparation launch');
  expectRecorded('decision preparation', captured!);
});

/* --------------------------- refused launches --------------------------- */

/** Run directories no run row owns, and what each holds; and the run's other leftovers. */
function leftovers(state: Ready, normalizer: Normalizer): Json {
  const { runsRoot, checkLogRoot, agentTemporaryRoot } = state.context.config.execution;
  const database = openDatabase(state.context.storage.databasePath);
  let ids: Set<string>;
  try {
    ids = new Set(
      (database.prepare('SELECT id FROM agent_runs').all() as { id: string }[]).map((r) => r.id),
    );
  } finally {
    database.close();
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const unowned = existsSync(runsRoot)
    ? readdirSync(runsRoot)
        .filter((name) => uuid.test(name) && !ids.has(name))
        .sort()
    : [];
  // Keys are normalized; the file digests are already over normalized texts.
  return {
    runDirectories: Object.fromEntries(
      unowned.map((id) => [normalizer.text(id), tree(join(runsRoot, id), normalizer)]),
    ),
    checkLogs: Object.fromEntries(
      unowned
        .filter((id) => existsSync(join(checkLogRoot, id)))
        .map((id) => [normalizer.text(id), tree(join(checkLogRoot, id), normalizer)]),
    ),
    processDirectories: existsSync(agentTemporaryRoot)
      ? readdirSync(agentTemporaryRoot).filter((name) => /^[0-9a-f]{12}$/.test(name)).length
      : 0,
  };
}

/** A refusal as the caller sees it: status and error body. */
const refusalOf = (response: { statusCode: number; json: () => unknown }) => ({
  status: response.statusCode,
  body: response.json() as Json,
});

/**
 * A cycle fixture whose plan has an adopted repository policy (R-G6): items integrate into
 * `revision`, and `main` is the frozen experimental branch.
 */
async function policyFixture(outputs: readonly ScriptedReply[], now: () => Date) {
  const backend = new CycleBackend(outputs);
  const state = await ready({ backend, now });
  const root = fixtureRepository();
  git(['branch', 'revision'], root);
  const { worktree } = await registerAndWorktree(state, root, 'revision');
  await admit(state);
  const path = 'plan-versions/version-1/repository-policy';
  const preview = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/${path}`,
    headers: { cookie: state.cookie },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const adopted = await branchCommand(state, path, {
    expectedVersion: 0,
    expectedBranchSettingsVersion: 1,
    controlMode: 'controller-local',
    experimentalFreeze: preview.json().proposedFreeze,
    interpretation: 'Use controller gates now; preserve the experimental baseline.',
    publicationRequirement: 'Verify remote protections before first publication.',
  });
  expect(adopted.statusCode, adopted.body).toBe(200);
  return { state, backend, worktree, root };
}

/** Moves the frozen branch: the policy's evidence then has an issue, which refuses a launch. */
const moveFrozenBranch = (root: string) => commitFile(root, 'frozen.txt', 'moved\n');

const manualRun = (state: Ready, worktreeId: string) =>
  state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId, role: 'implement', permissionMode: 'auto' },
  });

it('pins what a launch refused by the repository policy leaves behind (R-B7 increment 1, AGT-12)', async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree, root } = await policyFixture([implementationDone], () => now);
  moveFrozenBranch(root);
  const refused = await manualRun(state, worktree.id);
  expect(backend.launches).toHaveLength(0);
  const normalizer = new Normalizer(rootsOf(state, fixtureRoots(worktree.path, root)));
  expectRecorded('refused: repository policy', {
    refusal: normalizer.value(refusalOf(refused)),
    leftovers: leftovers(state, normalizer),
  });
});

it('pins what a launch the drain refused at its record leaves, and the relaunch of the same run into it (R-B7 increment 1, AGT-12)', async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree, root } = await cycleFixture([designDone], () => now);
  const runs = state.context.services.agentRunService;
  const branches = present(state.context.services.executionService.branches);
  const evidence = branches.policyEvidence.bind(branches);
  // The drain begins after the documents are written, before the run's record.
  let drains = 0;
  const spy = vi.spyOn(branches, 'policyEvidence').mockImplementation(async (...args) => {
    if (drains++ === 0) runs.beginDrain();
    return evidence(...args);
  });
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => spy.mock.calls.length === 1 && runs.isDraining(), 'the drain');
  await stepDaemons(2);
  expect(backend.launches).toHaveLength(0);
  const normalizer = new Normalizer(rootsOf(state, fixtureRoots(worktree.path, root)));
  const refused = {
    cycle: normalizer.value({
      status: currentCycle(state, cycle).status,
      attention: currentCycle(state, cycle).attention ?? null,
      reason: currentCycle(state, cycle).reason,
    }),
    leftovers: leftovers(state, normalizer),
  };
  runs.cancelDrain();
  let captured: Json | undefined;
  backend.onLaunch = (request) => {
    captured ??= captureLaunch(state, request, fixtureRoots(worktree.path, root), 'relaunch');
  };
  await waitFor(() => captured !== undefined, 'the relaunch');
  expect(backend.launches).toHaveLength(1);
  expectRecorded('refused: drain at the record, then relaunched', {
    refused,
    relaunch: captured!,
  });
});

it('pins what a launch refused by a phase gate in its record leaves behind (R-B7 increment 1, AGT-12)', async () => {
  const f = await slicedFixture();
  const { state } = f;
  const a = await scopeTree(f, f.scopes[0]!);
  const b = await scopeTree(f, f.scopes[1]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  const responses = await Promise.all([launchScoped(f, a), launchScoped(f, b)]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const refused = present(responses.find((r) => r.statusCode === 409));
  const normalizer = new Normalizer(rootsOf(state, [[f.root, '<repository>']]));
  expectRecorded('refused: phase gate in the record', {
    refusal: normalizer.value(refusalOf(refused)),
    leftovers: leftovers(state, normalizer),
  });
});

it("pins a design recovery refused because its inputs changed, and that refusal before the policy's when both hold (R-B7 increment 1, decision 2)", async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const { state, worktree, root } = await policyFixture(
    [{ resultText: '## Open questions\nWhich storage format?' }, designDone],
    () => now,
  );
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
  const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
  const snapshot = (
    await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
  ).json();
  const launched = await state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(state),
    payload: {
      expectedVersion: snapshot.expectedVersion,
      snapshotDigest: snapshot.snapshotDigest,
      mode: 'continue',
      profile: { backend: 'claude-code', model: 'recovery-model' },
      instructions: 'Use SQLite.',
      attachments: [],
    },
  });
  expect(launched.statusCode, launched.body).toBe(200);
  // Its inputs change before the launch, and so does the repository policy.
  const reserved = currentCycle(state, cycle);
  state.context.storage.execution.cycles.replace(
    {
      ...reserved,
      designRecovery: { ...present(reserved.designRecovery), snapshotDigest: '0'.repeat(64) },
      version: reserved.version + 1,
    },
    reserved.version,
  );
  moveFrozenBranch(root);
  await waitFor(() => currentCycle(state, cycle).status !== 'running', 'the refused launch');
  const normalizer = new Normalizer(rootsOf(state, fixtureRoots(worktree.path, root)));
  const stopped = currentCycle(state, cycle);
  expectRecorded('refused: design recovery inputs and policy', {
    cycle: normalizer.value({
      status: stopped.status,
      attention: stopped.attention ?? null,
      reason: stopped.reason,
    }),
    leftovers: leftovers(state, normalizer),
  });
});

it("pins what a cycle's launch refused by a phase gate in its record leaves, and its relaunch into it once capacity frees (R-B7 increment 1, AGT-12)", async () => {
  const f = await slicedFixture();
  const { state, backend } = f;
  const tree = await scopeTree(f, f.scopes[0]!);
  const other = await scopeTree(f, f.scopes[1]!);
  const storage = state.context.storage;
  storage.phaseScheduling.setCapacity('local-development', 1);
  const branches = present(state.context.services.executionService.branches);
  const evidence = branches.policyEvidence.bind(branches);
  // Another worktree takes the capacity after the scope gates passed, before the run's record
  // reserves it.
  let calls = 0;
  vi.spyOn(branches, 'policyEvidence').mockImplementation(async (...args) => {
    if (calls++ === 0)
      storage.phaseScheduling.acquire({
        id: 'held-elsewhere',
        workspaceId: state.workspaceId,
        worktreeId: other.id,
        ownerId: 'held-elsewhere',
        phase: 'start',
        resourceKey: 'local-development',
        capacity: 1,
        acquiredAt: '2026-10-17T12:00:00.000Z',
      });
    return evidence(...args);
  });
  const cycle = await startCycle({ ...state, workItemId: present(tree.workItemId) }, tree.id);
  await waitFor(() => calls >= 1 && !!currentCycle(state, cycle).phaseWait, 'the phase wait');
  expect(backend.launches).toHaveLength(0);
  const normalizer = new Normalizer(rootsOf(state, [[f.root, '<repository>']]));
  const waiting = currentCycle(state, cycle);
  const refused = {
    cycle: normalizer.value({
      status: waiting.status,
      attention: waiting.attention ?? null,
      phaseWait: waiting.phaseWait ?? null,
      reason: waiting.reason,
    }),
    leftovers: leftovers(state, normalizer),
  };
  let captured: Json | undefined;
  backend.onLaunch = (request) => {
    captured ??= captureLaunch(
      state,
      request,
      [
        [tree.path, '<worktree>'],
        [f.root, '<repository>'],
      ],
      'phase-relaunch',
    );
  };
  storage.phaseScheduling.release('held-elsewhere', '2026-10-17T12:01:00.000Z', 'released');
  await waitFor(() => captured !== undefined, 'the relaunch');
  expect(present(captured as { run: { id: string } }).run.id).toBe(
    normalizer.text(waiting.currentRunId),
  );
  expectRecorded('refused: phase gate in a cycle launch, then relaunched', {
    refused,
    relaunch: captured!,
  });
});
