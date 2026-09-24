import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
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
  if (options.write && !existsSync(path)) {
    const directory = join(runDirectory, TOOL_RESULTS_DIRECTORY);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)
      throw new Error('The run tool-result directory is not a plain directory');
    // Write then rename, so a crash never leaves a partial body under the digest's name.
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
 * Reads a body back, or undefined when it has expired with the run's scratch or was never
 * stored. A body whose contents no longer match its digest is treated as absent.
 */
export function readToolResult(runDirectory: string, digest: string): string | undefined {
  if (!DIGEST.test(digest)) return undefined;
  const path = bodyPath(runDirectory, digest);
  if (!existsSync(path)) return undefined;
  const content = gunzipSync(readFileSync(path));
  return createHash('sha256').update(content).digest('hex') === digest
    ? content.toString('utf8')
    : undefined;
}
