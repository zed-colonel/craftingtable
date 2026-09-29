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

/** Whether an `href` value leads somewhere inside the app. */
function inApp(value: Node): boolean {
  const expression =
    value.type === 'JSXExpressionContainer' ? (value.expression as Node) : (value as Node);
  if (expression.type === 'Literal' && typeof expression.value === 'string')
    return expression.value.startsWith('/') && !expression.value.startsWith('/api/');
  if (expression.type === 'TemplateLiteral') {
    const first = ((expression.quasis as Node[])[0]?.value as { raw: string } | undefined)?.raw;
    // A template that starts with a value (`${base}/…`) hides where it leads: use `Link`,
    // `PathLink`, or a named download helper.
    if (first === '') return true;
    return (first ?? '').startsWith('/') && !(first ?? '').startsWith('/api/');
  }
  // A path held in a variable or property: `PathLink` reads it as a route.
  if (expression.type === 'Identifier' || expression.type === 'MemberExpression') return true;
  if (expression.type === 'CallExpression')
    return (
      (expression.callee as Node).type === 'Identifier' &&
      (expression.callee as Node).name === 'buildPath'
    );
  return false;
}

function rawInAppLinks(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const { program } = parseSync(file, source);
  const found: string[] = [];
  const visit = (node: Node) => {
    if (node.type === 'JSXElement') {
      const opening = node.openingElement as Node;
      if ((opening.name as Node).type === 'JSXIdentifier' && (opening.name as Node).name === 'a')
        for (const attribute of (opening.attributes as Node[]) ?? []) {
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
    .flatMap(rawInAppLinks);
  expect(offenders).toEqual([]);
});
