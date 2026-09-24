import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acceptAnyRecord,
  copyDatabase,
  inspectMigrationStatus,
  openCraftingTableStorage,
} from '@craftingtable/storage';
import { type RecordVerification, verified, verifyRecords } from './persisted-records.js';

/**
 * Checks every record in a database against the current contracts (R-H3).
 *
 *   pnpm db:verify <database.sqlite>          print a report; exit 1 when anything fails
 *   pnpm db:verify <database.sqlite> --json   the same report as JSON
 *
 * The file is copied with SQLite's backup API and only the copy is opened, migrated forward
 * and read, exactly as the current daemon would read it. Run it against a snapshot before
 * deploying a contract or schema change. Snapshots hold real plans and agent output: keep
 * them and any report outside the repository.
 */
export async function verifyDatabase(
  path: string,
): Promise<RecordVerification & { readonly schema: { from: number; to: number } }> {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-verify-'));
  try {
    const copy = join(directory, 'verify.sqlite');
    await copyDatabase(path, copy);
    const from = inspectMigrationStatus(copy).currentVersion;
    const storage = openCraftingTableStorage(copy, acceptAnyRecord);
    try {
      return {
        ...verifyRecords(storage),
        schema: { from, to: storage.migrationStatus.currentVersion },
      };
    } finally {
      storage.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Groups issues by field and message, so a report lists defects rather than rows. */
export function groupedIssues(verification: RecordVerification) {
  const groups = new Map<string, { count: number; example: string }>();
  for (const record of verification.invalid)
    for (const issue of record.issues) {
      const label = `${record.kind} ${issue.replace(/\.\d+(?=\.|:)/g, '.N')}`;
      const group = groups.get(label) ?? { count: 0, example: record.key };
      group.count++;
      groups.set(label, group);
    }
  for (const record of verification.unreadable) {
    const label = `${record.kind} unreadable: ${record.error}`;
    const group = groups.get(label) ?? { count: 0, example: record.key };
    group.count++;
    groups.set(label, group);
  }
  return [...groups].map(([issue, group]) => ({ issue, ...group }));
}

export function formatVerification(
  path: string,
  verification: Awaited<ReturnType<typeof verifyDatabase>>,
): string {
  const lines = [
    `db:verify ${path}`,
    `schema ${verification.schema.from} -> ${verification.schema.to} on the copy`,
    '',
    `${'kind'.padEnd(26)}${'records'.padStart(9)}${'invalid'.padStart(9)}`,
  ];
  for (const [kind, count] of Object.entries(verification.counts))
    lines.push(
      `${kind.padEnd(26)}${String(count.records).padStart(9)}${String(count.invalid).padStart(9)}`,
    );
  const upcasts = Object.entries(verification.upcasts);
  lines.push('', upcasts.length ? 'Upcast on read:' : 'Upcast on read: none');
  for (const [label, count] of upcasts) lines.push(`  ${count}x ${label}`);
  const groups = groupedIssues(verification);
  lines.push('', groups.length ? 'Contract violations:' : 'Contract violations: none');
  for (const group of groups)
    lines.push(`  ${group.count}x ${group.issue} (for example ${group.example})`);
  lines.push(
    '',
    verification.integrity.length ? 'Integrity:' : 'Integrity: ok',
    ...verification.integrity.map((problem) => `  ${problem}`),
  );
  const records = Object.values(verification.counts).reduce((sum, c) => sum + c.records, 0);
  lines.push(
    '',
    verified(verification)
      ? `PASS: ${records} records conform`
      : `FAIL: ${verification.invalid.length} invalid, ${verification.unreadable.length} unreadable, ${verification.integrity.length} integrity problems in ${records} records`,
  );
  return `${lines.join('\n')}\n`;
}

async function main(args: readonly string[]): Promise<number> {
  // pnpm runs the script in the server package; paths are relative to where it was invoked.
  const base = process.env.INIT_CWD ?? process.cwd();
  const json = args.includes('--json');
  const [pathArg, ...rest] = args.filter((arg) => arg !== '--json');
  if (!pathArg || rest.length) {
    process.stderr.write('Usage: pnpm db:verify <database.sqlite> [--json]\n');
    return 2;
  }
  const path = resolve(base, pathArg);
  const verification = await verifyDatabase(path);
  process.stdout.write(
    json
      ? `${JSON.stringify({ ...verification, groups: groupedIssues(verification) }, null, 2)}\n`
      : formatVerification(path, verification),
  );
  return verified(verification) ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMain) process.exitCode = await main(process.argv.slice(2));
