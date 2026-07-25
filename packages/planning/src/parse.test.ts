import { describe, expect, it } from 'vitest';
import { parseYamlDocument } from './parse.js';
import { readInvalidFixtureText } from './test-support.js';

/** CT03-A14 and CT03-A24: YAML safety and resource bounds. */

function codes(text: string, name = 'probe.yaml'): readonly string[] {
  const result = parseYamlDocument(text, name);
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe('safe YAML parsing', () => {
  it('accepts ordinary planning YAML as plain data', () => {
    const result = parseYamlDocument('document: X\npull_requests: []\n', 'ok.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ document: 'X', pull_requests: [] });
    }
  });

  it('reports malformed YAML with a location instead of throwing (CT03-A14)', () => {
    const result = parseYamlDocument(readInvalidFixtureText('malformed.yaml'), 'malformed.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('invalid-yaml');
      expect(result.diagnostics[0]?.artifactName).toBe('malformed.yaml');
      expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
    }
  });

  it('refuses unresolved tags rather than interpreting them (CT03-A14)', () => {
    // The `core` schema cannot construct an object from this tag, but refusing
    // it outright means an unrecognised tag can never be silently reinterpreted
    // as data we then act on.
    expect(codes(readInvalidFixtureText('unknown-tag.yaml'))).toEqual(['invalid-yaml']);
    expect(codes('a: !Ref something\n')).toEqual(['invalid-yaml']);
  });

  it('bounds alias expansion (CT03-A24)', () => {
    expect(codes(readInvalidFixtureText('alias-bomb.yaml'))).toEqual(['yaml-too-complex']);
  });

  it('rejects prototype-poisoning keys (CT03-A24)', () => {
    expect(codes(readInvalidFixtureText('unsafe-key.yaml'))).toEqual(['unsafe-yaml-key']);
    expect(codes('constructor: 1\n')).toEqual(['unsafe-yaml-key']);
    expect(codes('nested:\n  prototype: 1\n')).toEqual(['unsafe-yaml-key']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects more than one document (CT03-A24)', () => {
    expect(codes('a: 1\n---\nb: 2\n')).toEqual(['multiple-yaml-documents']);
  });

  it('rejects duplicate mapping keys', () => {
    expect(codes('a: 1\na: 2\n')).toEqual(['invalid-yaml']);
  });

  it('bounds nesting depth (CT03-A24)', () => {
    const deep = `${'{a: '.repeat(40)}1${'}'.repeat(40)}\n`;
    expect(codes(deep)).toEqual(['yaml-too-complex']);
  });

  it('bounds total node count (CT03-A24)', () => {
    const wide = `items: [${Array.from({ length: 25_000 }, (_, index) => index).join(',')}]\n`;
    expect(codes(wide)).toEqual(['yaml-too-complex']);
  });

  it('rejects scalars JSON cannot represent', () => {
    // The 1.2 core schema yields Infinity for an overflowing float literal;
    // storing that would produce a row the JSON contracts could not round-trip.
    expect(codes('a: 1e999\n')).toEqual(['unsupported-yaml-scalar']);
  });

  it('stringifies non-string mapping keys rather than failing', () => {
    const result = parseYamlDocument('1: one\ntrue: yes\n', 'keys.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ '1': 'one', true: 'yes' });
    }
  });

  it('treats an empty document as invalid rather than as an empty plan', () => {
    expect(codes('')).toEqual(['invalid-yaml']);
  });
});
