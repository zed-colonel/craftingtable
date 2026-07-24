import {
  PLAN_BUNDLE_LIMITS,
  type PlanBundleArtifactInput,
  type TransportFinding,
} from '@craftingtable/planning';
import type { FastifyRequest } from 'fastify';

/**
 * Bounded multipart reading for plan import.
 *
 * The transport's job is only to produce bytes plus logical metadata within
 * hard limits; every interpretation decision belongs to the pure planning
 * package. Limits come from `PLAN_BUNDLE_LIMITS` so stream enforcement and
 * validation policy cannot drift apart.
 *
 * Note that `@fastify/multipart` already reduces `part.filename` to a base
 * name, so a path-shaped upload name never reaches the validator. That is
 * defence in depth, not the guarantee: the pure validator rejects separators,
 * traversal segments, and control characters independently.
 */

export const MULTIPART_PLUGIN_LIMITS = {
  fieldNameSize: 64,
  fieldSize: PLAN_BUNDLE_LIMITS.maxFieldByteLength,
  fields: PLAN_BUNDLE_LIMITS.maxFields,
  // One over the accepted count so an over-limit request is *observed* and
  // diagnosed rather than silently truncated by the parser.
  fileSize: PLAN_BUNDLE_LIMITS.maxBytesPerArtifact + 1,
  files: PLAN_BUNDLE_LIMITS.maxArtifacts + 1,
  headerPairs: PLAN_BUNDLE_LIMITS.maxHeaderPairs,
  parts: PLAN_BUNDLE_LIMITS.maxParts,
} as const;

export interface PlanImportRequestParts {
  readonly fields: Readonly<Record<string, string>>;
  readonly artifacts: readonly PlanBundleArtifactInput[];
  readonly transportFindings: readonly TransportFinding[];
}

export class MalformedMultipartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedMultipartError';
  }
}

/**
 * Streams one multipart request into bounded in-memory parts.
 *
 * Reading stops accumulating once the total budget is exhausted, so a hostile
 * request cannot force the daemon to buffer more than the declared maximum. No
 * database transaction is open while this runs.
 */
export async function readPlanImportParts(
  request: FastifyRequest,
): Promise<PlanImportRequestParts> {
  if (!request.isMultipart()) {
    throw new MalformedMultipartError('Expected a multipart/form-data request');
  }

  const fields: Record<string, string> = {};
  const artifacts: PlanBundleArtifactInput[] = [];
  const transportFindings: TransportFinding[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
        continue;
      }

      fileCount += 1;
      if (fileCount > PLAN_BUNDLE_LIMITS.maxArtifacts) {
        // Drain rather than abort so the client still receives our response.
        part.file.resume();
        continue;
      }

      const chunks: Buffer[] = [];
      let byteLength = 0;
      let overBudget = false;
      for await (const chunk of part.file) {
        const buffer = chunk as Buffer;
        byteLength += buffer.byteLength;
        if (totalBytes + byteLength > PLAN_BUNDLE_LIMITS.maxTotalBytes) {
          overBudget = true;
          break;
        }
        if (byteLength <= PLAN_BUNDLE_LIMITS.maxBytesPerArtifact) {
          chunks.push(buffer);
        }
      }
      if (overBudget) {
        part.file.resume();
      }
      totalBytes += byteLength;

      artifacts.push({
        fieldName: part.fieldname,
        filename: part.filename,
        declaredMediaType: part.mimetype,
        bytes: new Uint8Array(Buffer.concat(chunks)),
        // `truncated` is set by the plugin at its own limit; the explicit byte
        // comparison covers the over-budget break above.
        ...(part.file.truncated === true ||
        byteLength > PLAN_BUNDLE_LIMITS.maxBytesPerArtifact ||
        overBudget
          ? { truncated: true }
          : {}),
      });
    }
  } catch (cause) {
    throw new MalformedMultipartError(
      cause instanceof Error ? cause.message : 'Multipart request could not be read',
    );
  }

  if (fileCount > PLAN_BUNDLE_LIMITS.maxArtifacts) {
    transportFindings.push({ kind: 'too-many-artifacts', observed: fileCount });
  }
  if (totalBytes > PLAN_BUNDLE_LIMITS.maxTotalBytes) {
    transportFindings.push({ kind: 'total-size-exceeded', observed: totalBytes });
  }

  return { fields, artifacts, transportFindings };
}
