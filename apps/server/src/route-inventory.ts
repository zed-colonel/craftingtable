import * as contracts from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import { type DeclaredRoute, declaredRoutes } from './routes/route-access.js';

/**
 * The daemon's route inventory (R-H5, H5-4), generated from the route table as registered: each
 * API route's method, path, access, tag, step-up rule and body schema. `docs/api-routes.md` is
 * this text; the route inventory test regenerates it and fails when the two differ, and the web's
 * decision boundary test reads the tags from it.
 */
export function routeInventory(app: FastifyInstance): string {
  const routes = [...declaredRoutes(app).values()].toSorted(
    (a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method),
  );
  const count = (predicate: (route: DeclaredRoute) => boolean) => routes.filter(predicate).length;
  const tags = (['read', 'decision', 'control', 'config'] as const)
    .map((tag) => `${count((r) => r.tag === tag)} ${tag}`)
    .join(', ');
  return [
    '# API routes',
    '',
    "Generated from the daemon's route table by `pnpm routes:inventory` (R-H5); do not edit by hand.",
    "The route inventory test fails when this file and the route table differ, and the web's",
    'decision boundary test reads each `decision` route from it.',
    '',
    '- **Access** is the least role a route admits (`route-access.ts`): `public`, `session`, or a',
    '  workspace role (`member`, `editor`, `owner`), or `installation` (the owner of every active',
    '  workspace). Every command also needs the CSRF token and an allowed origin.',
    '- **Tag** says what a route does: a `read`; a `decision` (resolves an operator decision, posted',
    '  from one decision component in the browser, R-A6); a `control` (acts on work in progress or',
    '  on the session); or `config` (settings, imports and definitions).',
    "- **Step-up** is the route's own rule for asking for the password again (R-G9). Every command",
    '  also asks when its body grants `unrestricted` anywhere.',
    "- **Body** is the shared contract the daemon parses a command's body with before its handler",
    '  runs; for a multipart upload, its text fields.',
    '',
    `**${routes.length} routes:** ${count((r) => r.method === 'GET')} GET, ${count((r) => r.method === 'POST')} POST; ${tags}.`,
    '',
    '| Method | Path (under `/api/`) | Access | Tag | Step-up | Body |',
    '|---|---|---|---|---|---|',
    ...routes.map(
      (r) =>
        `| ${r.method} | \`${r.url.slice('/api/'.length)}\` | ${r.access} | ${r.tag} | ${r.stepUpRule ?? ''} | ${bodyName(r)} |`,
    ),
    '',
  ].join('\n');
}

/** Each contract schema by its export name; a schema exported twice keeps its first name. */
const schemaNames = new Map<unknown, string>();
for (const [name, schema] of Object.entries(contracts))
  if (name.endsWith('Schema') && !schemaNames.has(schema)) schemaNames.set(schema, name);

/** A command's body schema by its contract name; one the contracts do not export is refused. */
function bodyName(route: DeclaredRoute): string {
  if (route.body === undefined) return '';
  const name = schemaNames.get(route.body);
  if (name === undefined)
    throw new Error(
      `${route.method} ${route.url} declares a body schema the contracts do not export (R-H5).`,
    );
  return `\`${name}\`${route.multipart ? ' (multipart fields)' : ''}`;
}
