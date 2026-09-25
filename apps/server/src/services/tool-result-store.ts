import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  type AgentRunEventPayload,
  TOOL_RESULT_PREVIEW_BYTES,
  truncateUtf8Bytes,
} from '@craftingtable/domain';

/**
 * Large tool-result bodies, kept compressed in the run's directory instead of the journal
 * (R-H2). The journal keeps a preview and the body's SHA-256; the file is named by that
 * digest, so a body is written once and is checked when read. The agent is given the run
 * directory, so nothing here is trusted: a body that no longer matches its digest reads as
 * absent, and the daemon never writes through a directory an agent replaced with a link.
 */
export const TOOL_RESULTS_DIRECTORY = 'tool-results';

const DIGEST = /^[a-f0-9]{64}$/;

/**
 * No stored body can be larger: the adapters refuse vendor lines over 4 MiB, and a tool
 * result is one line. Reads stop here, so a planted file cannot exhaust the daemon's memory.
 */
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

function bodyPath(runDirectory: string, digest: string): string {
  return join(runDirectory, TOOL_RESULTS_DIRECTORY, `${digest}.txt.gz`);
}

/**
 * Returns the payload to journal: unchanged when the output fits in the preview, otherwise
 * the preview plus a reference to the body written under `runDirectory`. Throws if the
 * body cannot be written, and the caller then journals the whole output. With `write:
 * false` it only computes the result (compaction's dry run).
 */
export function offloadToolResult(
  payload: AgentRunEventPayload<'tool-result'>,
  runDirectory: string,
  options: { readonly write: boolean } = { write: true },
): AgentRunEventPayload<'tool-result'> {
  if (payload.body !== undefined) return payload;
  const bytes = Buffer.byteLength(payload.content, 'utf8');
  if (bytes <= TOOL_RESULT_PREVIEW_BYTES) return payload;
  const digest = createHash('sha256').update(payload.content, 'utf8').digest('hex');
  const path = bodyPath(runDirectory, digest);
  if (options.write && readToolResult(runDirectory, digest) === undefined) {
    const directory = join(runDirectory, TOOL_RESULTS_DIRECTORY);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)
      throw new Error('The run tool-result directory is not a plain directory');
    // Write then rename, so a crash never leaves a partial body under the digest's name. A
    // file already there that does not hold this output is replaced, not trusted.
    const partial = `${path}.${randomUUID()}.partial`;
    writeFileSync(partial, gzipSync(Buffer.from(payload.content, 'utf8')), { mode: 0o600 });
    renameSync(partial, path);
  }
  return {
    ...payload,
    content: truncateUtf8Bytes(payload.content, TOOL_RESULT_PREVIEW_BYTES),
    body: { digest, bytes },
  };
}

/**
 * Reads a body back, or undefined when it has expired with the run's scratch, was never
 * stored, or is not a regular file holding exactly the output with this digest. The file is
 * opened without following a link and read only up to the body limit, so a FIFO, a device or
 * a compression bomb planted in the run directory reads as absent instead of blocking or
 * exhausting the daemon.
 */
export function readToolResult(runDirectory: string, digest: string): string | undefined {
  if (!DIGEST.test(digest)) return undefined;
  let descriptor: number;
  try {
    descriptor = openSync(
      bodyPath(runDirectory, digest),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.size > BODY_LIMIT_BYTES) return undefined;
    const content = gunzipSync(readFileSync(descriptor), { maxOutputLength: BODY_LIMIT_BYTES });
    return createHash('sha256').update(content).digest('hex') === digest
      ? content.toString('utf8')
      : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}
