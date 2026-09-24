/** `pnpm craftingtable:dev` entry: the CLI against the development daemon's state. */
import './dev-environment.js';

const { runCli } = await import('./cli.js');
try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
  process.exitCode = 1;
}
