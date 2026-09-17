/** Read-only, bounded toolchain observation through the existing process supervisor. */
import { spawnSupervisedProcess } from './process.js';
export async function observeRustToolchain(
  executables: { cargo: string; rustc: string },
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ cargo: string; rustc: string }> {
  const observe = async (executable: string) => {
    const child = spawnSupervisedProcess({
      executable,
      args: ['--version', '--verbose'],
      cwd,
      env: { ...env, RUSTUP_AUTO_INSTALL: '0' },
      terminationGraceMs: 200,
      maxLineBytes: 8192,
      backgroundWorkTimeoutMs: 1000,
    });
    child.endInput();
    let output = '',
      stderrBytes = 0,
      failed = false,
      exited = false;
    const deadline = setTimeout(() => {
      failed = true;
      child.terminate();
    }, 5000);
    try {
      for await (const item of child.items) {
        if (item.type === 'stdout-line' && !failed) output += `${item.line}\n`;
        if (item.type === 'stderr') stderrBytes += Buffer.byteLength(item.text);
        if (item.type === 'stdout-overflow' || output.length > 16384 || stderrBytes > 16384) {
          failed = true;
          child.terminate();
        }
        if (item.type === 'exited') {
          exited = true;
          failed ||= item.exitCode !== 0 || !!item.backgroundWorkIncomplete;
        }
      }
      if (failed || !exited || !output.trim())
        throw new Error(
          'Could not observe the installed Rust toolchain. Check that Cargo and rustc are available for the registered repository.',
        );
      return output.trim();
    } finally {
      clearTimeout(deadline);
    }
  };
  return { cargo: await observe(executables.cargo), rustc: await observe(executables.rustc) };
}
