import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { expect, it } from 'vitest';

/**
 * In-app navigation goes through `Link` (R-E1, UI-07): a plain `<a href="/workspaces/…">`
 * reloads the document and discards unsaved drafts. The check reads every component's JSX and
 * fails on an `<a>` whose `href` is an in-app path: a string or template starting with `/`
 * (except API downloads under `/api/`), a `buildPath(…)` call, or a path it cannot see (a
 * variable, a property, or a template that starts with a value). In-page fragments (`#…`),
 * external URLs and named download helpers stay plain anchors. `Link` itself is the one place
 * that renders one.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const LINK_MODULE = join(root, 'lib', 'navigation.tsx');

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
function children(node: Node): Node[] {
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'parent'
      ? []
      : Array.isArray(value)
        ? value.filter(isNode)
        : isNode(value)
          ? [value]
          : [],
  );
}
function components(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return components(path);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
  });
}

/** Helpers that build API downloads, not pages; any other call is treated as an in-app path. */
const DOWNLOAD_HELPERS = new Set(['archiveDownloadPath', 'buildRecordDownload']);

/** Whether a string's start makes it a page inside the app. */
const appPath = (text: string) => text.startsWith('/') && !text.startsWith('/api/');

/**
 * Whether an `href` value may lead somewhere inside the app. Anything the check cannot read
 * counts as in-app (R-E1 review): a value it cannot see is exactly where a reload hides.
 */
function inApp(value: Node): boolean {
  const expression =
    value.type === 'JSXExpressionContainer' ? (value.expression as Node) : (value as Node);
  switch (expression.type) {
    case 'Literal':
      return typeof expression.value === 'string' && appPath(expression.value);
    case 'TemplateLiteral': {
      const first = ((expression.quasis as Node[])[0]?.value as { raw: string } | undefined)?.raw;
      // A template that starts with a value (`${base}/…`) hides where it leads.
      return first === '' || appPath(first ?? '');
    }
    case 'CallExpression': {
      const callee = expression.callee as Node;
      return !(callee.type === 'Identifier' && DOWNLOAD_HELPERS.has(callee.name as string));
    }
    case 'ConditionalExpression':
      return inApp(expression.consequent as Node) || inApp(expression.alternate as Node);
    case 'BinaryExpression':
      return inApp(expression.left as Node);
    default:
      return true;
  }
}

function rawInAppLinks(file: string, source = readFileSync(file, 'utf8')): string[] {
  const { program } = parseSync(file, source);
  const found: string[] = [];
  const visit = (node: Node) => {
    if (node.type === 'JSXElement') {
      const opening = node.openingElement as Node;
      if ((opening.name as Node).type === 'JSXIdentifier' && (opening.name as Node).name === 'a')
        for (const attribute of (opening.attributes as Node[]) ?? []) {
          // Spread props can carry an href the check cannot see.
          if (attribute.type === 'JSXSpreadAttribute') {
            found.push(
              `${relative(root, file)}:${source.slice(0, node.start as number).split('\n').length}`,
            );
            continue;
          }
          if ((attribute.name as Node | undefined)?.name !== 'href' || !attribute.value) continue;
          if (inApp(attribute.value as Node)) {
            const line = source.slice(0, node.start as number).split('\n').length;
            found.push(`${relative(root, file)}:${line}`);
          }
        }
    }
    for (const child of children(node)) visit(child);
  };
  visit(program as unknown as Node);
  return found;
}

it('navigates inside the app only through Link, never a reloading anchor (R-E1, UI-07)', () => {
  const offenders = components(root)
    .filter((file) => file !== LINK_MODULE)
    .flatMap((file) => rawInAppLinks(file));
  expect(offenders).toEqual([]);
});

/**
 * The detector itself (TS-M11): with it disabled, the test above passes over a clean tree, so
 * this one plants each shape it must catch, the R-E1 review's four (a call, a ternary, a
 * concatenation, a spread) among them, next to anchors it must leave alone.
 */
it('reports each planted in-app anchor and nothing else', () => {
  const caught = [
    '<a href="/workspaces/w1">a</a>',
    '<a href={`/runs/${id}`}>a</a>',
    '<a href={`${base}/runs`}>a</a>',
    '<a href={path}>a</a>',
    '<a href={buildPath(route)}>a</a>',
    '<a href={open ? "/runs" : "#runs"}>a</a>',
    '<a href={"/runs/" + id}>a</a>',
    '<a {...props}>a</a>',
  ];
  const allowed = [
    '<a href="#runs">a</a>',
    '<a href="https://example.com/">a</a>',
    '<a href="/api/runs/r1/log">a</a>',
    '<a href={archiveDownloadPath(id)}>a</a>',
  ];
  const source = [
    'export const Planted = () => (',
    '  <>',
    ...[...caught, ...allowed].map((anchor) => `    ${anchor}`),
    '  </>',
    ');',
  ].join('\n');
  expect(rawInAppLinks(join(root, 'planted.tsx'), source)).toEqual(
    caught.map((_, index) => `planted.tsx:${index + 3}`),
  );
});
