import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkDeclarationPreviewSchema,
  registerSourceRepositoryResponseSchema,
  repositoryChecksViewSchema,
} from '@craftingtable/contracts';
import {
  asWorkspaceId,
  asWorkspaceMembershipId,
  CHECK_DECLARATION_PATH,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  fixtureRepository,
  git,
  mutationHeaders,
  ready,
  type Ready,
} from './execution-test-support.js';
import { ForbiddenError } from './services/errors.js';

afterEach(cleanupExecutionFixtures);

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const SCRIPT = '#!/bin/sh\ncargo test --workspace\n';

/** A registered repository whose `main` proposes a script check and a check on PATH. */
async function checksFixture() {
  const state = await ready({ backend: null });
  const root = fixtureRepository();
  mkdirSync(join(root, '.craftingtable'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/check.sh'), SCRIPT, { mode: 0o755 });
  writeFileSync(
    join(root, CHECK_DECLARATION_PATH),
    JSON.stringify({
      version: 1,
      checks: [
        { id: 'tests', argv: ['scripts/check.sh'] },
        { id: 'format', argv: ['cargo', 'fmt', '--check'] },
      ],
    }),
  );
  git(['add', '--all'], root);
  git(['commit', '-m', 'checks'], root);
  const registered = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/repositories`,
    headers: mutationHeaders(state),
    payload: { rootPath: root, displayName: 'Checked' },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const repository = registerSourceRepositoryResponseSchema.parse(registered.json()).repository;
  const base = `/api/workspaces/${state.workspaceId}/repositories/${repository.id}/checks`;
  const post = (path: 'preview' | 'adopt', payload: object, headers = mutationHeaders(state)) =>
    state.context.app.inject({ method: 'POST', url: `${base}/${path}`, headers, payload });
  return { state, root, repository, base, post };
}

const adopted = (state: Ready, response: { json(): unknown }) => {
  const view = repositoryChecksViewSchema.parse(response.json());
  expect(view.declarations).toEqual(
    state.context.storage.runtimeEvidence.checkDeclarations(state.workspaceId, view.repositoryId),
  );
  return view;
};

it('adopts the checks file at the commit the operator reviewed, never the working tree or another branch (R-G13)', async () => {
  const f = await checksFixture();
  const main = git(['rev-parse', 'main'], f.root).trim();
  // An agent's branch and uncommitted working-tree changes propose weaker checks.
  git(['checkout', '-b', 'agent'], f.root);
  writeFileSync(
    join(f.root, CHECK_DECLARATION_PATH),
    JSON.stringify({ version: 1, checks: [{ id: 'tests', argv: ['true'] }] }),
  );
  git(['commit', '-am', 'weaker'], f.root);
  writeFileSync(join(f.root, 'scripts/check.sh'), '#!/bin/sh\nexit 0\n');
  git(['checkout', '-f', 'main'], f.root);
  writeFileSync(join(f.root, 'scripts/check.sh'), '#!/bin/sh\nexit 0\n');

  const previewed = await f.post('preview', { ref: 'main' });
  expect(previewed.statusCode, previewed.body).toBe(200);
  const preview = checkDeclarationPreviewSchema.parse(previewed.json());
  expect(preview).toEqual({
    ref: 'main',
    commitSha: main,
    sourcePath: CHECK_DECLARATION_PATH,
    checks: [
      // A script always defines its own check.
      { id: 'tests', argv: ['scripts/check.sh'], definitionPaths: ['scripts/check.sh'] },
      { id: 'format', argv: ['cargo', 'fmt', '--check'], definitionPaths: [] },
    ],
    definitionDigests: { 'scripts/check.sh': sha(SCRIPT) },
    // The operator reads what the check runs, as committed.
    definitions: [
      {
        path: 'scripts/check.sh',
        digest: sha(SCRIPT),
        bytes: SCRIPT.length,
        text: SCRIPT,
        truncated: false,
      },
    ],
    issues: [],
    // A program from PATH with no definition files is adoptable, with a warning.
    warnings: [
      expect.stringContaining('Check format runs cargo from PATH and names no definition files'),
    ],
  });
  // Preview records nothing.
  expect(
    f.state.context.storage.runtimeEvidence.checkDeclarations(f.state.workspaceId, f.repository.id),
  ).toEqual([]);

  const first = await f.post('adopt', {
    ref: 'main',
    expectedCommit: main,
    rationale: 'The project suite.',
  });
  expect(first.statusCode, first.body).toBe(200);
  const view = adopted(f.state, first);
  expect(view.declarations).toMatchObject([
    {
      version: 1,
      sourceCommit: main,
      checks: preview.checks,
      definitionDigests: preview.definitionDigests,
      rationale: 'The project suite.',
      adoptedByUserId: f.state.userId,
    },
  ]);
  const audit = f.state.context.storage.audit
    .listWorkspace({ workspaceId: f.state.workspaceId, limit: 50 })
    .filter((e) => e.action === 'repository-checks.adopted');
  expect(audit).toMatchObject([
    {
      targetId: f.repository.id,
      outcome: 'succeeded',
      metadata: { declarationId: view.declarations[0]!.id, version: 1, sourceCommit: main },
    },
  ]);

  // Adopting the agent's branch is the operator's explicit act, and makes a new version.
  const agent = git(['rev-parse', 'agent'], f.root).trim();
  const second = await f.post('adopt', {
    ref: 'agent',
    expectedCommit: agent,
    rationale: 'Deliberately weaker.',
  });
  expect(second.statusCode, second.body).toBe(200);
  expect(adopted(f.state, second).declarations.map((d) => [d.version, d.sourceCommit])).toEqual([
    [2, agent],
    [1, main],
  ]);
  const listed = await f.state.context.app.inject({
    method: 'GET',
    url: f.base,
    headers: { cookie: f.state.cookie },
  });
  expect(listed.statusCode, listed.body).toBe(200);
  expect(adopted(f.state, listed).declarations).toHaveLength(2);
});

it('refuses to adopt a ref that moved since review, or a file with issues (R-G13)', async () => {
  const f = await checksFixture();
  const reviewed = git(['rev-parse', 'main'], f.root).trim();
  git(['commit', '--allow-empty', '-m', 'moved'], f.root);
  const moved = await f.post('adopt', {
    ref: 'main',
    expectedCommit: reviewed,
    rationale: 'Reviewed earlier.',
  });
  expect(moved.statusCode).toBe(409);
  expect(moved.body).toContain('main has moved since it was reviewed');

  const propose = async (file: string | undefined, extra: Record<string, string> = {}) => {
    git(['checkout', '-q', '--orphan', `case-${randomUUID()}`], f.root);
    git(['rm', '-rfq', '--cached', '--ignore-unmatch', '.'], f.root);
    const files: Record<string, string> = { ...extra };
    if (file !== undefined) files[CHECK_DECLARATION_PATH] = file;
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(f.root, path, '..'), { recursive: true });
      writeFileSync(join(f.root, path), content);
      git(['add', path], f.root);
    }
    git(['commit', '-q', '--allow-empty', '-m', 'case'], f.root);
    const commit = git(['rev-parse', 'HEAD'], f.root).trim();
    const preview = checkDeclarationPreviewSchema.parse(
      (await f.post('preview', { ref: commit })).json(),
    );
    // A file with issues cannot be adopted.
    if (preview.issues.length) {
      const adopt = await f.post('adopt', { ref: commit, expectedCommit: commit, rationale: 'x' });
      expect(adopt.statusCode).toBe(409);
      expect(adopt.body).toContain(preview.issues[0]!.slice(0, 40));
    }
    return preview.issues;
  };
  const one = (check: object) => JSON.stringify({ version: 1, checks: [check] });
  expect(await propose(undefined)).toEqual([
    expect.stringContaining(`${CHECK_DECLARATION_PATH} is not a file in`),
  ]);
  expect(await propose('{')).toEqual([`${CHECK_DECLARATION_PATH} is not JSON.`]);
  expect((await propose(one({ id: 'abs', argv: ['/usr/bin/true'] }))).join()).toContain(
    'A check program with a path is a repository path',
  );
  expect((await propose(one({ id: 'up', argv: ['../outside.sh'] }))).join()).toContain(
    'A check program with a path is a repository path',
  );
  expect((await propose(one({ id: 'opt', argv: ['--version'] }))).join()).toContain(
    'A check starts with its program',
  );
  expect(
    (
      await propose(
        JSON.stringify({
          version: 1,
          checks: [
            { id: 'twice', argv: ['true'] },
            { id: 'twice', argv: ['false'] },
          ],
        }),
      )
    ).join(),
  ).toContain('Each check has its own id');
  expect(await propose(one({ id: 'gone', argv: ['scripts/missing.sh'] }))).toEqual([
    expect.stringContaining(
      'scripts/missing.sh, a definition file of a declared check, is not a file in',
    ),
  ]);
  // Naming other definition files adds to the program; it never replaces it.
  expect(
    await propose(one({ id: 'own', argv: ['scripts/missing.sh'], definitionPaths: ['Makefile'] }), {
      Makefile: 'check:\n\ttrue\n',
    }),
  ).toEqual([expect.stringContaining('scripts/missing.sh, a definition file')]);
  expect(
    await propose(one({ id: 'plain', argv: ['scripts/plain.sh'] }), {
      'scripts/plain.sh': '#!/bin/sh\n',
    }),
  ).toEqual([
    expect.stringContaining('scripts/plain.sh, the program of check plain, is not executable'),
  ]);
  expect(
    await propose(one({ id: 'named', argv: ['make', 'check'], definitionPaths: ['Makefile'] }), {
      Makefile: 'check:\n\ttrue\n',
    }),
  ).toEqual([]);
  expect(
    f.state.context.storage.runtimeEvidence.checkDeclarations(f.state.workspaceId, f.repository.id),
  ).toEqual([]);
});

it('keeps each adoption immutable in storage (R-G13)', async () => {
  const f = await checksFixture();
  const main = git(['rev-parse', 'main'], f.root).trim();
  expect(
    (await f.post('adopt', { ref: 'main', expectedCommit: main, rationale: 'Suite.' })).statusCode,
  ).toBe(200);
  const db = openDatabase(f.state.context.storage.databasePath);
  try {
    expect(() =>
      db.prepare("UPDATE repository_check_declarations SET record_json='{}'").run(),
    ).toThrow('immutable');
    expect(() => db.prepare('DELETE FROM repository_check_declarations').run()).toThrow(
      'immutable',
    );
  } finally {
    db.close();
  }
});

it('lets members read adopted checks and only editors preview or adopt them, with CSRF (R-G13)', async () => {
  const f = await checksFixture();
  const main = git(['rev-parse', 'main'], f.root).trim();
  const adopt = { ref: 'main', expectedCommit: main, rationale: 'Suite.' };
  expect((await f.state.context.app.inject({ method: 'GET', url: f.base })).statusCode).toBe(401);
  const { 'x-craftingtable-csrf': _, ...withoutCsrf } = mutationHeaders(f.state);
  expect((await f.post('adopt', adopt, withoutCsrf)).statusCode).toBe(403);

  // A viewer of another workspace can neither read nor change this repository's checks.
  const other = asWorkspaceId(randomUUID());
  const now = new Date().toISOString();
  f.state.context.storage.workspaces.insert({
    id: other,
    name: 'Read only',
    slug: 'read-only',
    createdByUserId: f.state.userId,
    occurredAt: now,
  });
  f.state.context.storage.workspaces.insertMembership({
    id: asWorkspaceMembershipId(randomUUID()),
    workspaceId: other,
    userId: f.state.userId,
    role: 'viewer',
    occurredAt: now,
  });
  const elsewhere = `/api/workspaces/${other}/repositories/${f.repository.id}/checks`;
  const viewerGet = await f.state.context.app.inject({
    method: 'GET',
    url: elsewhere,
    headers: { cookie: f.state.cookie },
  });
  expect(viewerGet.statusCode).toBe(400);
  for (const path of ['preview', 'adopt'])
    expect(
      (
        await f.state.context.app.inject({
          method: 'POST',
          url: `${elsewhere}/${path}`,
          headers: mutationHeaders(f.state),
          payload: adopt,
        })
      ).statusCode,
    ).toBe(403);
  // The service checks the role itself, not only the route.
  const context = f.state.context.services.authService.authenticate(f.state.cookie.split('=')[1]!);
  const service = f.state.context.services.repositoryChecksService;
  await expect(service.adopt(context, other, f.repository.id, adopt)).rejects.toThrow(
    ForbiddenError,
  );
  await expect(service.preview(context, other, f.repository.id, 'main')).rejects.toThrow(
    ForbiddenError,
  );
  expect(
    f.state.context.storage.runtimeEvidence.checkDeclarations(f.state.workspaceId, f.repository.id),
  ).toEqual([]);
});

it('reads only the files it needs, so links and large files elsewhere do not block adoption (R-G13 review)', async () => {
  const f = await checksFixture();
  symlinkSync('README.md', join(f.root, 'link-to-readme'));
  writeFileSync(join(f.root, 'large.bin'), Buffer.alloc(17 * 1024 * 1024, 1));
  git(['add', '--all'], f.root);
  git(['commit', '-m', 'a link and a large file'], f.root);
  const previewed = await f.post('preview', { ref: 'main' });
  expect(previewed.statusCode, previewed.body).toBe(200);
  expect(checkDeclarationPreviewSchema.parse(previewed.json()).issues).toEqual([]);
  // A definition that is a link is refused by name.
  git(['rm', '-q', 'scripts/check.sh'], f.root);
  mkdirSync(join(f.root, 'scripts'), { recursive: true });
  symlinkSync('../README.md', join(f.root, 'scripts/check.sh'));
  git(['add', '--all'], f.root);
  git(['commit', '-m', 'linked script'], f.root);
  expect(
    checkDeclarationPreviewSchema.parse((await f.post('preview', { ref: 'main' })).json()).issues,
  ).toEqual([
    expect.stringContaining('scripts/check.sh, a definition file of a declared check, is a link'),
  ]);
});

it('reads a branch, never a tag of the same name, or an exact commit (R-G13 review)', async () => {
  const f = await checksFixture();
  const main = git(['rev-parse', 'main'], f.root).trim();
  // Anyone who can write refs, an agent included, tags a weaker file "main".
  git(['checkout', '-q', '-b', 'weaker'], f.root);
  writeFileSync(
    join(f.root, CHECK_DECLARATION_PATH),
    JSON.stringify({ version: 1, checks: [{ id: 'tests', argv: ['true'] }] }),
  );
  git(['commit', '-qam', 'weaker'], f.root);
  git(['tag', 'main'], f.root);
  git(['checkout', '-q', 'main'], f.root);
  const read = async (ref: string) =>
    checkDeclarationPreviewSchema.parse((await f.post('preview', { ref })).json());
  expect((await read('main')).commitSha).toBe(main);
  expect((await read(main)).commitSha).toBe(main);
  const tagOnly = await f.post('preview', { ref: 'refs/tags/main' });
  expect(tagOnly.statusCode).toBe(400);
  expect(tagOnly.body).toContain('is not a branch or a complete commit ID');
});
