/**
 * Upload limits mirrored for browser-side pre-validation.
 *
 * The browser cannot import `@craftingtable/planning` — it depends only on
 * domain and contracts (ADR-012) — so these values are restated here. They are
 * a courtesy check only: the daemon enforces the authoritative limits and
 * records a durable diagnostic when one is exceeded.
 */
export const PLAN_BUNDLE_LIMITS = {
  maxArtifacts: 12,
  maxBytesPerArtifact: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
} as const;
