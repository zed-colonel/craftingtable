import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { expect, it } from 'vitest';

/**
 * Copy rules from docs/ui-principles.md, "Copy" (R-E6, UI-11): headings stay short, and
 * explanatory prose lives in an `About` disclosure. The check reads every component's JSX:
 *
 * - a heading (`h1`–`h6`, `legend`, or the `title` of `Section` or `PageHeader`) has at most
 *   HEADING_WORDS words of fixed text;
 * - a paragraph has at most PROSE_CHARACTERS characters of fixed text unless it sits inside
 *   `About` or reports state: `role="status"` or `"alert"`, or an `error-state`,
 *   `warning-state` or `empty-state` class.
 *
 * Only fixed text is measured: interpolated values are left out, and where the text is a
 * choice (`cond ? 'a' : 'b'`) the longest branch counts. Rendering a paragraph under a
 * condition does not exempt it: loading guards and permission checks wrap prose that is, in
 * practice, always shown.
 */
const HEADING_WORDS = 8;
const PROSE_CHARACTERS = 160;
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend']);
const TITLED = new Set(['Section', 'PageHeader']);

const root = fileURLToPath(new URL('.', import.meta.url));

type Node = { type: string; [key: string]: unknown };

function components(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return components(path);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
  });
}

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

/** Classes and roles that mark a paragraph as reported state rather than explanation. */
const STATE_CLASSES = ['error-state', 'warning-state', 'empty-state'];
const STATE_ROLES = ['status', 'alert'];

function attribute(node: Node, name: string): string | undefined {
  for (const a of ((node.openingElement as Node).attributes as Node[]) ?? []) {
    if ((a.name as Node | undefined)?.name !== name) continue;
    const value = a.value as Node | undefined;
    return value?.type === 'Literal' ? String(value.value) : '';
  }
  return undefined;
}

/** A paragraph that reports state (an error, a warning, a status line) may run longer. */
function stateParagraph(node: Node): boolean {
  const role = attribute(node, 'role');
  const classes = attribute(node, 'className')?.split(/\s+/) ?? [];
  return (
    (role !== undefined && STATE_ROLES.includes(role)) ||
    classes.some((c) => STATE_CLASSES.includes(c))
  );
}

function elementName(node: Node): string | undefined {
  const name = (node.openingElement as Node | undefined)?.name as Node | undefined;
  return name?.type === 'JSXIdentifier' ? (name.name as string) : undefined;
}

/** The fixed text a JSX subtree or expression shows, without interpolated values. */
function fixedText(node: Node): string {
  switch (node.type) {
    case 'JSXText':
      return node.value as string;
    case 'Literal':
      return typeof node.value === 'string' ? node.value : '';
    case 'TemplateLiteral':
      return (node.quasis as Node[])
        .map((q) => ((q.value as { cooked?: string }).cooked ?? '') as string)
        .join(' ');
    case 'JSXExpressionContainer':
      return fixedText(node.expression as Node);
    // A choice shows one branch: measure the longest.
    case 'ConditionalExpression': {
      const [a, b] = [fixedText(node.consequent as Node), fixedText(node.alternate as Node)];
      return a.length >= b.length ? a : b;
    }
    case 'LogicalExpression':
      return fixedText(node.right as Node);
    case 'JSXElement':
    case 'JSXFragment':
      return (node.children as Node[]).map(fixedText).join('');
    default:
      return '';
  }
}

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
const words = (text: string) => normalized(text).split(' ').filter(Boolean).length;

export interface CopyViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: 'heading' | 'prose';
  readonly text: string;
}

export function copyViolations(file: string, source: string): CopyViolation[] {
  const program = parseSync(file, source, { lang: 'tsx' }).program as unknown as Node;
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const violations: CopyViolation[] = [];
  const visit = (node: Node, inAbout: boolean) => {
    let about = inAbout;
    if (node.type === 'JSXElement') {
      const name = elementName(node);
      if (name === 'About') about = true;
      if (name && HEADING_TAGS.has(name)) {
        const text = normalized(fixedText(node));
        if (words(text) > HEADING_WORDS)
          violations.push({ file, line: lineOf(node.start as number), rule: 'heading', text });
      }
      if (name && TITLED.has(name))
        for (const attribute of ((node.openingElement as Node).attributes as Node[]) ?? []) {
          const attributeName = (attribute.name as Node | undefined)?.name;
          const value = attribute.value as Node | undefined;
          if (attributeName !== 'title' || !value) continue;
          const text = normalized(fixedText(value));
          if (words(text) > HEADING_WORDS)
            violations.push({ file, line: lineOf(node.start as number), rule: 'heading', text });
        }
      if (name === 'p' && !about && !stateParagraph(node)) {
        const text = normalized(fixedText(node));
        if (text.length > PROSE_CHARACTERS)
          violations.push({ file, line: lineOf(node.start as number), rule: 'prose', text });
      }
    }
    for (const child of children(node)) visit(child, about);
  };
  visit(program, false);
  return violations;
}

it('keeps headings short and explanatory prose inside About (R-E6)', () => {
  const violations = components(root).flatMap((path) =>
    copyViolations(relative(root, path), readFileSync(path, 'utf8')),
  );
  expect(violations.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.text.slice(0, 100)}`)).toEqual(
    [],
  );
});

it('measures fixed copy outside About, except reported state', () => {
  const long = 'word '.repeat(40).trim();
  const check = (jsx: string) =>
    copyViolations('Example.tsx', `export const A = () => (${jsx});`).map((v) => v.rule);
  expect(
    check(`<Section title="One two three four five six seven eight nine"><p/></Section>`),
  ).toEqual(['heading']);
  expect(check(`<h3>Short title {value} with a value</h3>`)).toEqual([]);
  expect(check(`<h3>{busy ? 'Retrying' : '${long}'}</h3>`)).toEqual(['heading']);
  expect(check(`<div><p>${long}</p></div>`)).toEqual(['prose']);
  expect(check(`<About label="About"><p>${long}</p></About>`)).toEqual([]);
  expect(check(`<div>{open && <p>${long}</p>}</div>`)).toEqual(['prose']);
  expect(check(`<p role="alert">${long}</p>`)).toEqual([]);
  expect(check(`<p className="warning-state">${long}</p>`)).toEqual([]);
  expect(check(`<p className="hint">${long}</p>`)).toEqual(['prose']);
});
