import { isRecord, stringOf } from '../bounded.js';
import { spawnSupervisedProcess } from '../process.js';
import { CodexRpc } from './rpc.js';

/**
 * Codex features a supervised run never loads (R-G5, AGT-14): the operator's plugins and the
 * apps they bring, hooks and memories.
 */
export const CODEX_ISOLATION_FLAGS = [
  '--disable',
  'plugins',
  '--disable',
  'apps',
  '--disable',
  'hooks',
  '--disable',
  'memories',
] as const;

/** What the operator's own Codex configuration adds: MCP servers and user skills. */
export interface CodexInventory {
  readonly mcpServers: readonly string[];
  readonly userSkills: readonly string[];
}

const CONFIG_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * App-server arguments that switch off every MCP server and user skill in `inventory`. A name
 * a `-c` override cannot address is refused rather than left loaded.
 */
export function codexIsolationArguments(inventory: CodexInventory): string[] {
  for (const name of [...inventory.mcpServers, ...inventory.userSkills])
    if (!CONFIG_NAME.test(name))
      throw new Error(
        `Codex configuration ${JSON.stringify(name.slice(0, 100))} cannot be switched off for supervised runs; rename it.`,
      );
  return [
    ...CODEX_ISOLATION_FLAGS,
    ...inventory.mcpServers.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
    ...(inventory.userSkills.length
      ? [
          '-c',
          `skills.config=[${inventory.userSkills
            .map((name) => `{name="${name}",enabled=false}`)
            .join(',')}]`,
        ]
      : []),
  ];
}

/** What an app-server has loaded: enabled skills by scope, and MCP servers that are live. */
export async function readCodexLoaded(
  rpc: CodexRpc,
  cwd: string,
): Promise<{
  readonly skills: readonly { readonly name: string; readonly scope: string }[];
  readonly mcpServers: readonly { readonly name: string; readonly live: boolean }[];
}> {
  const skills = await rpc.request('skills/list', { cwds: [cwd] });
  const servers = await rpc.request('mcpServerStatus/list', {});
  const entries = isRecord(skills) && Array.isArray(skills.data) ? skills.data : [];
  return {
    skills: entries.flatMap((entry) =>
      isRecord(entry) && Array.isArray(entry.skills)
        ? entry.skills.flatMap((skill) =>
            isRecord(skill) && skill.enabled !== false && stringOf(skill.name)
              ? [{ name: stringOf(skill.name).slice(0, 200), scope: stringOf(skill.scope) }]
              : [],
          )
        : [],
    ),
    mcpServers: (isRecord(servers) && Array.isArray(servers.data) ? servers.data : []).flatMap(
      (server) =>
        isRecord(server) && stringOf(server.name)
          ? [
              {
                name: stringOf(server.name).slice(0, 200),
                live:
                  server.runtimeStatus !== null && server.runtimeStatus !== undefined
                    ? true
                    : isRecord(server.tools) && Object.keys(server.tools).length > 0,
              },
            ]
          : [],
    ),
  };
}

/**
 * Runs `use` against a short-lived app-server started with the isolation flags, then ends it.
 * Nothing it says is journaled.
 */
export async function withCodexAppServer<T>(
  options: {
    readonly executable: string;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly timeoutMs: number;
    /** Ends the app-server, and so every request still pending, once this much has passed. */
    readonly deadlineMs?: number;
  },
  use: (rpc: CodexRpc) => Promise<T>,
): Promise<T> {
  const child = spawnSupervisedProcess({
    executable: options.executable,
    args: ['app-server', '--stdio', ...CODEX_ISOLATION_FLAGS],
    cwd: options.cwd,
    env: options.env,
    terminationGraceMs: 1000,
    maxLineBytes: 4 * 1024 * 1024,
    backgroundWorkTimeoutMs: options.timeoutMs,
  });
  const rpc = new CodexRpc(child, options.timeoutMs);
  const reading = (async () => {
    for await (const item of child.items) {
      if (item.type === 'exited') {
        rpc.close();
        return;
      }
      if (item.type !== 'stdout-line') continue;
      try {
        const value: unknown = JSON.parse(item.line);
        if (isRecord(value)) rpc.accept(value);
      } catch {
        /* Notifications and noise are not the probe's concern. */
      }
    }
  })();
  const deadline =
    options.deadlineMs === undefined
      ? undefined
      : setTimeout(() => child.terminate(), options.deadlineMs);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'craftingtable', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (!rpc.write({ method: 'initialized' })) throw new Error('Codex initialization failed');
    return await use(rpc);
  } finally {
    clearTimeout(deadline);
    child.terminate();
    await reading.catch(() => undefined);
  }
}

/**
 * Asks a short-lived app-server, started with the isolation flags, which MCP servers and user
 * skills the operator's configuration still adds, so the run's app-server can switch them off.
 */
export function probeCodexInventory(options: {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<CodexInventory> {
  return withCodexAppServer(options, async (rpc) => {
    const loaded = await readCodexLoaded(rpc, options.cwd);
    return {
      mcpServers: loaded.mcpServers.map((s) => s.name),
      userSkills: loaded.skills.filter((s) => s.scope === 'user').map((s) => s.name),
    };
  });
}
