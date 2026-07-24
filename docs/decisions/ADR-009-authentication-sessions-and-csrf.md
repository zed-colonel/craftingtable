# ADR-009 — Authentication, sessions, and CSRF

- **Status:** accepted
- **Date:** 2026-07-24

## Context

CT-02 introduces a browser login and protected local APIs without public
registration or a framework-owned session model. Passwords, bearer material,
and cross-site browser requests need explicit handling.

## Decision

- The only account creation path is the interactive bootstrap CLI.
- Hash passwords with `argon2` 0.45.1 using Argon2id. Accept 12–1024 UTF-8
  bytes and never log, audit, return, or persist plaintext.
- Generate opaque 32-byte random session tokens. Send the raw token only in
  the cookie and persist only its SHA-256 digest.
- Persist session status, absolute 30-day expiry, last-seen time, revocation
  time/reason, and a session-bound CSRF token.
- Cookies use `HttpOnly`, `SameSite=Strict`, `Path=/`, explicit expiry, and
  `Secure` when the configured public origin is HTTPS.
- Authenticated mutations require the CSRF token in
  `x-craftingtable-csrf`, compare it timing-safely, and enforce the configured
  same origin/fetch metadata.
- Login accepts JSON only, checks origin/fetch metadata, and returns one
  generic failure for missing users, wrong passwords, and disabled users.
- A user may list and revoke only their own sessions.
- Redact cookie, authorization, and set-cookie headers. Audit metadata is
  constructed from allowlisted fields, never request bodies.

## Consequences

Sessions can be revoked immediately and remain invalid after restart. There is
no public registration, password reset, role administration, or federated
identity in CT-02. The generic cookie name can become a `__Host-` name when
HTTPS is mandatory in CT-08.

## Alternatives considered

- `@fastify/session` — would obscure the required digest-backed record model.
- JWT/browser storage — harder revocation and greater bearer exposure.
- Cookie-only CSRF defense — `SameSite` is defense in depth, not the sole
  control.
