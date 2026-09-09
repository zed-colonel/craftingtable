import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { readHiddenPassword } from '../cli.js';

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    },
  }) as unknown as NodeJS.ReadStream;
  const output = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  let written = '';
  output.on('data', (chunk) => {
    written += chunk.toString();
  });
  return { input, output, written: () => written };
}

it('accepts split UTF-8 input and deletes whole code points without echoing secrets', async () => {
  const tty = terminal();
  const result = readHiddenPassword('Password: ', tty.input, tty.output);
  for (const byte of Buffer.from('café🔐\x7f猫\r')) tty.input.emit('data', Buffer.from([byte]));
  await expect(result).resolves.toBe('café猫');
  expect(tty.written()).toBe('Password: \n');
  expect(tty.input.isRaw).toBe(false);
  expect(tty.input.listenerCount('data')).toBe(0);
});

it.each(['\x03', '\x04'])('restores the terminal after cancellation', async (cancel) => {
  const tty = terminal();
  const result = readHiddenPassword('Password: ', tty.input, tty.output);
  tty.input.emit('data', Buffer.from(`secret${cancel}`));
  await expect(result).rejects.toThrow(/Canceled/);
  expect(tty.input.isRaw).toBe(false);
  expect(tty.written()).not.toContain('secret');
});

it('supports clearing a mistaken entry and refuses oversized input', async () => {
  const tty = terminal();
  const result = readHiddenPassword('Password: ', tty.input, tty.output);
  tty.input.emit('data', Buffer.from('mistake\x15new passphrase\r'));
  await expect(result).resolves.toBe('new passphrase');
  const long = readHiddenPassword('Password: ', tty.input, tty.output);
  tty.input.emit('data', Buffer.from('x'.repeat(1025)));
  await expect(long).rejects.toThrow(/1024/);
  expect(tty.input.isRaw).toBe(false);
});

it('refuses noninteractive input and cleans up on unexpected EOF', async () => {
  const tty = terminal();
  Object.assign(tty.input, { isTTY: false });
  await expect(readHiddenPassword('Password: ', tty.input, tty.output)).rejects.toThrow(
    /interactive/,
  );
  Object.assign(tty.input, { isTTY: true });
  const result = readHiddenPassword('Password: ', tty.input, tty.output);
  tty.input.emit('end');
  await expect(result).rejects.toThrow(/ended/);
  expect(tty.input.isRaw).toBe(false);
});
