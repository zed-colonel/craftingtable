import { createHash } from 'node:crypto';
import {
  PLAN_BUNDLE_DIGEST_ALGORITHM,
  PLAN_BUNDLE_DIGEST_FORMAT_VERSION,
} from '@craftingtable/domain';

/**
 * Canonical plan-bundle digest, format version 1
 * (work-items/CT-03/CT-03.md §5.6).
 *
 * `node:crypto` is a hashing primitive, not I/O: this module opens no file,
 * spawns no process, and touches no network, so the package stays pure in the
 * sense the contract requires.
 */

const DOMAIN_SEPARATOR = 'craftingtable-plan-bundle-digest-v1';

export interface DigestArtifact {
  readonly role: string;
  readonly logicalFilename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface BundleDigest {
  readonly hex: string;
  readonly algorithm: typeof PLAN_BUNDLE_DIGEST_ALGORITHM;
  readonly formatVersion: typeof PLAN_BUNDLE_DIGEST_FORMAT_VERSION;
}

function u32be(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function u64be(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}

function lengthPrefixedText(value: string): readonly Buffer[] {
  const encoded = Buffer.from(value, 'utf8');
  return [u32be(encoded.byteLength), encoded];
}

/** Byte-wise comparison, so ordering never depends on a locale collation. */
function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Computes the digest that gives a plan bundle its identity.
 *
 * Length-prefixing every field makes the encoding injective, so no two distinct
 * bundles can produce the same byte stream by concatenation. Multipart part
 * order, upload timestamps, temporary filenames, and generated identifiers are
 * absent from the encoding by construction and therefore cannot affect it.
 */
export function computeBundleDigest(artifacts: readonly DigestArtifact[]): BundleDigest {
  const ordered = [...artifacts].sort((left, right) => {
    const byRole = compareBytes(left.role, right.role);
    return byRole !== 0 ? byRole : compareBytes(left.logicalFilename, right.logicalFilename);
  });

  const hash = createHash('sha256');
  hash.update(Buffer.from(DOMAIN_SEPARATOR, 'ascii'));
  hash.update(Buffer.from([0x00]));
  hash.update(u32be(ordered.length));

  for (const artifact of ordered) {
    for (const chunk of lengthPrefixedText(artifact.role)) {
      hash.update(chunk);
    }
    for (const chunk of lengthPrefixedText(artifact.logicalFilename)) {
      hash.update(chunk);
    }
    for (const chunk of lengthPrefixedText(artifact.mediaType)) {
      hash.update(chunk);
    }
    hash.update(u64be(artifact.bytes.byteLength));
    hash.update(artifact.bytes);
  }

  return {
    hex: hash.digest('hex'),
    algorithm: PLAN_BUNDLE_DIGEST_ALGORITHM,
    formatVersion: PLAN_BUNDLE_DIGEST_FORMAT_VERSION,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
