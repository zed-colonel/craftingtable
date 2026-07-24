# CT-02 security model

CraftingTable is authenticated but remains loopback-only. Authentication does
not make LAN exposure safe; TLS and deployment hardening remain CT-08.

## Secrets and credentials

- Bootstrap is interactive and refuses password arguments. There is no
  registration endpoint.
- Passwords are Argon2id hashes at rest.
- Session cookies contain a 256-bit random token; SQLite stores only SHA-256.
- CSRF tokens are session-bound and sent only in authenticated JSON responses
  and the custom mutation header.
- Logs redact cookie, authorization, and set-cookie headers. Error responses
  are generic. Audit metadata uses explicit allowlists and excludes passwords,
  tokens, cookies, and request bodies.

## Request controls

- Cookies are `HttpOnly`, `SameSite=Strict`, `Path=/`, explicitly expiring,
  and `Secure` for HTTPS origins.
- Login accepts JSON only and rejects cross-site origin/fetch metadata.
- Logout and session revocation require exact same-origin policy plus a
  timing-safe CSRF comparison.
- Every workspace snapshot, audit query, and event stream performs
  service-layer membership authorization. Missing and unauthorized workspaces
  return the same public response.
- Sessions are server-side, expiring, revocable records. Stream loops
  revalidate sessions and membership.

## Remaining boundary

CT-02 exposes no shell, SQL, filesystem, process-control, Git, agent, or
verification endpoint. Users, memberships, and roles establish only a future
schema seam; the product does not yet activate collaborative account
administration.
