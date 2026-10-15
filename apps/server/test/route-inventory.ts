import * as contracts from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import { type DeclaredRoute, declaredRoutes, pathParameters } from '../src/routes/route-access.js';

/**
 * The daemon's route inventory (R-H5, H5-4), generated from the route table as registered: each
 * API route's method, path, access, tag, step-up rule, body schema, and its path parameters with
 * their schemas and refusal (R-H7). `docs/api-routes.md` is this text; the route inventory test
 * regenerates it and fails when the two differ, and the web's decision boundary test reads the
 * tags from it.
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
    "- **Parameters** are the route's path parameters, each with the shared contract the daemon",
    '  parses it with, once, before anything reads it (R-H7); handlers read the parsed values. A',
    "  workspace route's `workspaceId` is parsed with `workspaceIdSchema` by the access check, which",
    '  refuses one that does not parse with 404 before the body is read. A `…LookupSchema` admits',
    '  any text and only brands it: no handler checked that parameter before R-H7, so its service',
    '  still answers whatever it finds.',
    "- **Refused** is the answer to a route's own parameter (not the workspace's) that does not",
    '  parse, given once step-up and the body are settled: 404 with its message. A route whose own',
    '  parameters are all lookups refuses none: its service answers an unknown or malformed id (404',
    "  on most, 409 on a scope repair, roadmap control's own 400s first).",
    '',
    `**${routes.length} routes:** ${count((r) => r.method === 'GET')} GET, ${count((r) => r.method === 'POST')} POST; ${tags}. ${count((r) => pathParameters(r.url).length > 0)} take path parameters, ${count((r) => ownParameters(r).length > 0)} beyond the workspace's.`,
    '',
    '| Method | Path (under `/api/`) | Access | Tag | Step-up | Body | Parameters | Refused |',
    '|---|---|---|---|---|---|---|---|',
    ...routes.map(
      (r) =>
        `| ${r.method} | \`${r.url.slice('/api/'.length)}\` | ${r.access} | ${r.tag} | ${r.stepUpRule ?? ''} | ${bodyName(r)} | ${parameterNames(r)} | ${refusal(r)} |`,
    ),
    '',
  ].join('\n');
}

/** A schema by its contract name; one the contracts do not export is refused. */
function contractName(route: DeclaredRoute, schema: unknown, what: string): string {
  const name = schemaNames.get(schema);
  if (name === undefined)
    throw new Error(
      `${route.method} ${route.url} declares a ${what} schema the contracts do not export (R-H5, R-H7).`,
    );
  return name;
}

/** A route's own path parameters: all but a workspace route's `workspaceId`. */
function ownParameters(route: DeclaredRoute): readonly string[] {
  return pathParameters(route.url).filter(
    (name) => !(name === 'workspaceId' && route.url.startsWith('/api/workspaces/:workspaceId/')),
  );
}

/** Each path parameter, in path order, with its schema's contract name (R-H7). */
function parameterNames(route: DeclaredRoute): string {
  return pathParameters(route.url)
    .map(
      (name) => `\`${name}\` \`${contractName(route, route.params?.[name], `parameter ${name}`)}\``,
    )
    .join(', ');
}

/**
 * How the route refuses its own parameter that does not parse (R-H7). One whose own parameters are
 * all lookups never refuses one: its service answers what it finds.
 */
function refusal(route: DeclaredRoute): string {
  const own = ownParameters(route);
  if (own.length === 0) return '';
  if (
    own.every((name) =>
      contractName(route, route.params?.[name], `parameter ${name}`).endsWith('LookupSchema'),
    )
  )
    return 'none: its service answers';
  return `404 ${route.notFound ?? 'Resource not found'}`;
}

/** Each contract schema by its export name; a schema exported twice keeps its first name. */
const schemaNames = new Map<unknown, string>();
for (const [name, schema] of Object.entries(contracts))
  if (name.endsWith('Schema') && !schemaNames.has(schema)) schemaNames.set(schema, name);

/** A command's body schema by its contract name; one the contracts do not export is refused. */
function bodyName(route: DeclaredRoute): string {
  if (route.body === undefined) return '';
  return `\`${contractName(route, route.body, 'body')}\`${route.multipart ? ' (multipart fields)' : ''}`;
}
