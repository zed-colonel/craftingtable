import { describe, expect, it } from 'vitest';
import { parseCliArguments } from './cli.js';

describe('CLI argument parsing', () => {
  it('accepts bootstrap and database commands', () => {
    expect(parseCliArguments(['admin', 'bootstrap', '--username', 'keith'])).toEqual({
      command: 'bootstrap',
      username: 'keith',
    });
    expect(parseCliArguments(['db', 'migrate'])).toEqual({ command: 'db-migrate' });
    expect(parseCliArguments(['db', 'status'])).toEqual({ command: 'db-status' });
  });

  it('refuses passwords in process arguments', () => {
    expect(() =>
      parseCliArguments(['admin', 'bootstrap', '--username', 'keith', '--password', 'secret']),
    ).toThrow(/never/);
  });
});
