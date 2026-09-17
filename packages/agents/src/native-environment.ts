/** Fixed workstation probes and bounded user-service execution; no browser-supplied commands. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { arch, hostname, platform, release, homedir } from 'node:os';
import { join } from 'node:path';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const nativeExecutables = {
  systemdRun: '/usr/bin/systemd-run',
  systemctl: '/usr/bin/systemctl',
  cargo: join(homedir(), '.cargo/bin/cargo'),
  rustc: join(homedir(), '.cargo/bin/rustc'),
};
function identity(path: string) {
  try {
    const p = realpathSync(path),
      s = statSync(p);
    return { path: p, size: s.size, modified: s.mtimeMs };
  } catch {
    return { path, missing: true };
  }
}
export function nativeHostDigest() {
  return hash(
    JSON.stringify({
      version: 1,
      host: hostname(),
      os: platform(),
      kernel: release(),
      arch: arch(),
      uid: process.getuid?.(),
      executables: Object.values(nativeExecutables).map(identity),
    }),
  );
}
export function nativeUnit(runId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid native run identity.');
  return `craftingtable-native-${runId}.service`;
}
export function nativeArguments(unit: string, cwd: string, seconds: number, command: string[]) {
  return [
    '--user',
    '--wait',
    '--pipe',
    '--collect',
    '--quiet',
    `--unit=${unit}`,
    '--service-type=exec',
    `--working-directory=${cwd}`,
    '--property=CPUQuota=400%',
    '--property=MemoryMax=8G',
    '--property=MemorySwapMax=0',
    '--property=TasksMax=512',
    `--property=RuntimeMaxSec=${Math.max(1, Math.min(1800, Math.ceil(seconds)))}`,
    '--property=TimeoutStopSec=5',
    '--property=KillMode=control-group',
    '--property=NoNewPrivileges=yes',
    '--',
    ...command,
  ];
}
function probe(
  command: string,
  args: string[],
  timeout = 15000,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '',
      done = false;
    const child = spawn(command, args, {
      env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, output: output.slice(0, 16000) });
    };
    child.stdout.on('data', (b: Buffer) => {
      if (output.length < 16000) output += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      if (output.length < 16000) output += b.toString();
    });
    child.once('error', (e) => {
      output += e.message;
      finish(false);
    });
    child.once('close', (c) => finish(c === 0));
  });
}
export async function stopNativeUnit(runId: string) {
  const result = await probe(nativeExecutables.systemctl, ['--user', 'stop', nativeUnit(runId)]);
  // Collected units are already gone. A failed stop of an existing unit is an error.
  if (!result.ok && !/not loaded|not found|does not exist/.test(result.output))
    throw new Error(`Native cleanup failed: ${result.output}`);
}
export async function auditNativeEnvironment() {
  const issues: string[] = [];
  if (platform() !== 'linux')
    issues.push('Managed native verification requires Linux user services.');
  const unit = `craftingtable-native-audit-${randomUUID()}.service`;
  const [cargo, rustc, service] = await Promise.all([
    probe(nativeExecutables.cargo, ['--version']),
    probe(nativeExecutables.rustc, ['-vV']),
    probe(nativeExecutables.systemdRun, nativeArguments(unit, homedir(), 10, ['/usr/bin/true'])),
  ]);
  if (!cargo.ok || !rustc.ok)
    issues.push('Installed Cargo and Rust must be usable without auto-installation.');
  if (!service.ok) issues.push(`Bounded user-service smoke test failed: ${service.output}`);
  let kvmAvailable = false;
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    kvmAvailable = true;
  } catch {}
  const installed = existsSync('/opt/kata/bin/kata-runtime');
  let kataMessage = installed
    ? 'Kata installed; a separately recorded guest launch and cleanup test is required.'
    : 'Kata is not installed. Native verification does not require it.';
  const receiptPath = process.env.CRAFTINGTABLE_KATA_READINESS;
  if (receiptPath)
    try {
      const stat = lstatSync(receiptPath);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 65536)
        throw new Error('Receipt must be a bounded root-owned ordinary file.');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (
        installed &&
        receipt.success === true &&
        receipt.cleanupPassed === true &&
        receipt.runtime === 'io.containerd.kata.v2' &&
        receipt.hostKernel === release() &&
        typeof receipt.guestKernel === 'string' &&
        receipt.guestKernel !== release()
      )
        kataMessage = `Kata guest smoke test passed at ${receipt.at}: guest kernel ${receipt.guestKernel}; cleanup passed. Historical infrastructure readiness only; application qualification and managed Kata dispatch remain separate.`;
      else
        kataMessage =
          'Recorded Kata smoke test is failed or does not match this host kernel; rerun it before qualification.';
    } catch {
      kataMessage =
        'Kata readiness receipt is unavailable or invalid; rerun the managed smoke test.';
    }
  const hostDigest = nativeHostDigest();
  const facts = JSON.stringify(
    {
      version: 1,
      host: hostname(),
      kernel: release(),
      architecture: arch(),
      hostDigest,
      toolchains: { cargo: cargo.output.trim(), rustc: rustc.output.trim() },
      boundedService: service.ok,
      limits: { cpu: '4 CPUs', memory: '8 GiB', processes: 512, minutes: 30 },
      policy:
        'Non-sensitive repository test fixtures only. Fresh per-run HOME/TMPDIR; no inherited service credentials. Exact candidate, dependencies and test results retained. Existing trusted OS-user boundary applies; this is not a hostile-code sandbox. No Kata or external-service authorization.',
    },
    null,
    2,
  );
  return {
    hostDigest,
    auditDigest: hash(facts),
    facts,
    ready: !issues.length,
    issues,
    kata: {
      installed,
      kvmAvailable,
      message: kataMessage,
    },
  };
}
