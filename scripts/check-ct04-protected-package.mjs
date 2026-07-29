#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CT04_PROTECTED_MANIFEST = Object.freeze({
  'README.md': '4e857aca74d4c96f869a2f30e73f0aeb0153f8de2c0e77f972fea325647119fd',
  'CT-04-protected-acceptance-spec.yaml':
    'ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64',
});

export const CT04A2A_PROOF_FILES = Object.freeze([
  'packages/domain/src/repository.test.ts',
  'packages/contracts/src/repository.test.ts',
  'packages/storage/src/repository-schema.test.ts',
  'packages/storage/src/repository-repositories.test.ts',
  'packages/storage/src/repository-transitions.test.ts',
  'packages/storage/src/migration-0003.test.ts',
  'packages/storage/src/migration-0002.test.ts',
  'packages/storage/src/migrations.test.ts',
  'packages/storage/src/snapshot.test.ts',
  'apps/server/src/restart.test.ts',
  'scripts/check-forbidden-scope.test.mjs',
  'scripts/check-ct04-protected-package.test.mjs',
]);

export const CT04A2A_PROCESS_FILES = Object.freeze([
  'work-items/CT-04/CT-04A2a-proposed-implementation-plan.md',
  'review-findings/CT-04/CT-04A2a-design-review.md',
  'work-items/CT-04/CT-04A2a-review-disposition.md',
  'work-items/CT-04/CT-04A2a-accepted-implementation-plan.md',
  'implementation-reports/CT-04/CT-04A2a-initial-impl.md',
]);

export const CT04A2A_REVIEW_ADDED_PROOF_IDS = Object.freeze([
  'A2A-STATUS-015',
  'A2A-REP-015',
  'A2A-REP-016',
  'A2A-INSP-015',
  'A2A-INSP-016',
  'A2A-INSP-017',
  'A2A-INSP-018',
  'A2A-BASE-009',
  'A2A-BIND-013',
  'A2A-CON-009',
  'A2A-CON-010',
  'A2-SCOPE-003',
  'A2-SCOPE-004',
]);

export const CT04A2A_DOCUMENTARY_PROCESS_IDS = Object.freeze([
  'A2-PROC-001',
  'A2-PROC-002',
  'A2-PROC-003',
]);

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function testTitles(source) {
  const titles = [];
  const pattern = /^\s*(?:describe|it|test)\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/gm;
  for (const match of source.matchAll(pattern)) {
    titles.push(match[1] ?? match[2] ?? match[3]);
  }
  return titles;
}

function expandProofIds(title) {
  const ids = new Set();
  const rangePattern =
    /\b((?:A2A-(?:STATUS|REP|INSP|BASE|BIND|RET|MIG|CON)|A2-(?:PROC|SCOPE)))-(\d{3})\.\.(\d{3})\b/g;
  for (const match of title.matchAll(rangePattern)) {
    const start = Number(match[2]);
    const end = Number(match[3]);
    for (let value = start; value <= end; value += 1) {
      ids.add(`${match[1]}-${String(value).padStart(3, '0')}`);
    }
  }
  const slashPattern =
    /\b((?:A2A-(?:STATUS|REP|INSP|BASE|BIND|RET|MIG|CON)|A2-(?:PROC|SCOPE)))-(\d{3})((?:\/\d{3})+)\b/g;
  for (const match of title.matchAll(slashPattern)) {
    ids.add(`${match[1]}-${match[2]}`);
    for (const suffix of match[3].slice(1).split('/')) {
      ids.add(`${match[1]}-${suffix}`);
    }
  }
  const exactPattern =
    /\b(?:A2A-(?:STATUS|REP|INSP|BASE|BIND|RET|MIG|CON)|A2-(?:PROC|SCOPE))-\d{3}\b/g;
  for (const match of title.matchAll(exactPattern)) {
    ids.add(match[0]);
  }
  return ids;
}

export function ct04a2aProtectedIds(supplementSource) {
  const ids = [];
  const casePattern = /^- id: (\S+)\n {2}slice: CT-04A2a$/gm;
  for (const match of supplementSource.matchAll(casePattern)) {
    ids.push(match[1]);
  }
  return ids;
}

export function ct04a2aReviewAddedIds(acceptedPlanSource) {
  const start = acceptedPlanSource.indexOf('### 15.2 Review-added permanent cases');
  const end = acceptedPlanSource.indexOf('\n## 16.', start);
  if (start < 0 || end < start) {
    return [];
  }
  const section = acceptedPlanSource.slice(start, end);
  return [...section.matchAll(/`((?:A2A-[A-Z]+|A2-SCOPE)-\d{3})`/g)].map((match) => match[1]);
}

export function ct04a2aTestTitleIds(sources) {
  const ids = new Set();
  for (const source of sources) {
    for (const title of testTitles(source)) {
      for (const id of expandProofIds(title)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

export function verifyCt04ProtectedPackage(protectedDirectory) {
  let actualNames;
  try {
    actualNames = readdirSync(protectedDirectory).sort();
  } catch {
    return {
      ok: false,
      errors: ['protected package directory is missing or unreadable'],
    };
  }
  const expectedNames = Object.keys(CT04_PROTECTED_MANIFEST).sort();
  const errors = [];
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    errors.push('protected package file manifest differs from the pinned two-file manifest');
  }
  for (const [name, expectedHash] of Object.entries(CT04_PROTECTED_MANIFEST)) {
    const path = join(protectedDirectory, name);
    try {
      if (!statSync(path).isFile()) {
        errors.push(`${name} is not a regular file`);
      } else if (sha256(path) !== expectedHash) {
        errors.push(`${name} does not match its pinned SHA-256`);
      }
    } catch {
      errors.push(`${name} is missing or unreadable`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function readProcessSources(repositoryRoot) {
  return Object.fromEntries(
    CT04A2A_PROCESS_FILES.map((relativePath) => [
      relativePath,
      readFileSync(join(repositoryRoot, relativePath), 'utf8'),
    ]),
  );
}

export function verifyCt04A2aDocumentLineage(repositoryRoot) {
  let sources;
  try {
    sources = readProcessSources(repositoryRoot);
  } catch {
    return {
      ok: false,
      errors: ['CT-04A2a process lineage is missing or unreadable'],
    };
  }
  const proposedPath = CT04A2A_PROCESS_FILES[0];
  const reviewPath = CT04A2A_PROCESS_FILES[1];
  const dispositionPath = CT04A2A_PROCESS_FILES[2];
  const acceptedPath = CT04A2A_PROCESS_FILES[3];
  const proposedHash = sha256(join(repositoryRoot, proposedPath));
  const reviewHash = sha256(join(repositoryRoot, reviewPath));
  const dispositionHash = sha256(join(repositoryRoot, dispositionPath));
  const review = sources[reviewPath];
  const disposition = sources[dispositionPath];
  const accepted = sources[acceptedPath];
  const errors = [];

  if (!review.includes(proposedHash)) {
    errors.push('A2-PROC-001 design review does not pin the live proposed-plan SHA-256');
  }
  if (!disposition.includes(proposedHash) || !disposition.includes(reviewHash)) {
    errors.push('A2-PROC-001 disposition does not pin the reviewed plan and design review');
  }
  if (
    !accepted.includes(proposedHash) ||
    !accepted.includes(reviewHash) ||
    !accepted.includes(dispositionHash)
  ) {
    errors.push('A2-PROC-001 accepted plan does not carry the complete prior-artifact hash chain');
  }

  const appendixStart = accepted.indexOf('## 20. Review reconciliation appendix');
  const appendixEnd = accepted.indexOf('\n## 21.', appendixStart);
  const appendix =
    appendixStart >= 0 && appendixEnd > appendixStart
      ? accepted.slice(appendixStart, appendixEnd)
      : '';
  const findingIds = [...new Set(sources[reviewPath].match(/\bA2a-F-\d{2}\b/g) ?? [])].toSorted();
  if (findingIds.length !== 18 || findingIds.some((id) => !appendix.includes(`| ${id} |`))) {
    errors.push('A2-PROC-002 accepted-plan appendix does not map all 18 design findings');
  }
  return { ok: errors.length === 0, errors };
}

function git(repositoryRoot, args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function verifyCt04A2aGitLineage(repositoryRoot) {
  const reportPath = CT04A2A_PROCESS_FILES[4];
  let report;
  try {
    report = readFileSync(join(repositoryRoot, reportPath), 'utf8');
  } catch {
    return { ok: false, errors: ['A2-PROC-003 completion report is missing or unreadable'] };
  }
  const claimedHead = report.match(
    /\*\*Implementation head for independent review:\*\* `([0-9a-f]{40})`/,
  )?.[1];
  if (claimedHead === undefined) {
    return {
      ok: false,
      errors: ['A2-PROC-003 completion report has no exact implementation head'],
    };
  }
  const errors = [];
  try {
    git(repositoryRoot, ['cat-file', '-e', `${claimedHead}^{commit}`]);
  } catch {
    errors.push(`A2-PROC-003 claimed implementation head ${claimedHead} is not a commit`);
    return { ok: false, errors };
  }
  try {
    git(repositoryRoot, ['merge-base', '--is-ancestor', claimedHead, 'HEAD']);
  } catch {
    errors.push(
      `A2-PROC-003 claimed implementation head ${claimedHead} is not an ancestor of HEAD`,
    );
  }
  try {
    const introductionCommit = git(repositoryRoot, [
      'log',
      '--diff-filter=A',
      '--format=%H',
      '--',
      reportPath,
    ])
      .split('\n')
      .filter(Boolean)[0];
    const introductionParent = git(repositoryRoot, ['rev-parse', `${introductionCommit}^`]);
    if (introductionParent !== claimedHead) {
      errors.push(
        'A2-PROC-003 completion report was not introduced immediately after its claimed implementation head',
      );
    }
  } catch {
    errors.push('A2-PROC-003 completion-report introduction commit cannot be resolved');
  }
  return { ok: errors.length === 0, errors };
}

export function verifyCt04A2aProcessLineage(repositoryRoot) {
  const documentResult = verifyCt04A2aDocumentLineage(repositoryRoot);
  const gitResult = verifyCt04A2aGitLineage(repositoryRoot);
  const errors = [...documentResult.errors, ...gitResult.errors];
  return { ok: errors.length === 0, errors };
}

export function verifyCt04A2aProofAnchors(repositoryRoot) {
  const errors = [];
  let supplementSource;
  let acceptedPlanSource;
  try {
    supplementSource = readFileSync(
      join(repositoryRoot, 'work-items', 'CT-04', 'CT-04A2-protected-acceptance-supplement.yaml'),
      'utf8',
    );
    acceptedPlanSource = readFileSync(
      join(repositoryRoot, 'work-items', 'CT-04', 'CT-04A2a-accepted-implementation-plan.md'),
      'utf8',
    );
  } catch {
    return {
      ok: false,
      errors: ['CT-04A2a supplement or accepted plan is missing or unreadable'],
    };
  }

  const protectedIds = ct04a2aProtectedIds(supplementSource);
  if (protectedIds.length !== 91) {
    errors.push(`expected 91 protected CT-04A2a IDs, found ${protectedIds.length}`);
  }
  const reviewAddedIds = ct04a2aReviewAddedIds(acceptedPlanSource);
  if (
    reviewAddedIds.length !== CT04A2A_REVIEW_ADDED_PROOF_IDS.length ||
    reviewAddedIds.some((id, index) => id !== CT04A2A_REVIEW_ADDED_PROOF_IDS[index])
  ) {
    errors.push('accepted-plan section 15.2 review-added ID set differs from the pinned set');
  }
  const sources = [];
  for (const relativePath of CT04A2A_PROOF_FILES) {
    try {
      sources.push(readFileSync(join(repositoryRoot, relativePath), 'utf8'));
    } catch {
      errors.push(`${relativePath} is missing or unreadable`);
    }
  }
  const titleIds = ct04a2aTestTitleIds(sources);
  const titleRequiredIds = [...protectedIds, ...CT04A2A_REVIEW_ADDED_PROOF_IDS].filter(
    (id) => !CT04A2A_DOCUMENTARY_PROCESS_IDS.includes(id),
  );
  for (const id of titleRequiredIds) {
    if (!titleIds.has(id)) {
      errors.push(`${id} has no test-title anchor`);
    }
  }
  for (const source of sources) {
    for (const title of testTitles(source)) {
      for (const match of title.matchAll(/\bA2B-[A-Z]+-\d{3}\b/g)) {
        errors.push(`${match[0]} is an out-of-scope A2b test-title claim`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageResult = verifyCt04ProtectedPackage(join(repositoryRoot, 'protected'));
  const proofResult = verifyCt04A2aProofAnchors(repositoryRoot);
  const processResult = verifyCt04A2aProcessLineage(repositoryRoot);
  const errors = [...packageResult.errors, ...proofResult.errors, ...processResult.errors];
  if (errors.length > 0) {
    console.error('CT-04 protected-package verification FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log(
    'CT-04 protected-package verification passed: exact package and hashes, 101 A2a test-title anchors, and 3 documentary process-lineage controls.',
  );
}
