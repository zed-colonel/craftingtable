# ADR-009: Authentication, sessions, and CSRF

- **Status:** accepted
- **Date:** 2026-07-24
- **Amended:** 2026-10-12 (R-I7, SEC-04): the session cookie takes the `__Host-` prefix on an HTTPS origin

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
- Local recovery uses `admin reset-password --username <name>` with hidden, confirmed
  password entry. Existing OS access to the database grants this administrative authority;
  there is no unauthenticated web reset endpoint. The new hash, all session revocations
  and a system `user.password-changed` audit entry commit together. Asynchronous login
  and password-change operations recheck stored credentials before committing.
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

## Amendment 2026-10-12: the `__Host-` prefix on HTTPS (R-I7, SEC-04)

The consequence foreseen above is taken, for HTTPS origins rather than when HTTPS becomes
mandatory. On an HTTPS public origin the session cookie is `__Host-craftingtable_session`: a
browser accepts it only with `Secure`, `Path=/` and no `Domain`, so neither a sibling host nor a
plain-HTTP page on the same name can set or shadow it; cookies are scoped by host, not port, so
another HTTPS service on the same host still can. An HTTP origin keeps
`craftingtable_session`, because a browser refuses a `__Host-` cookie without `Secure`, and
loopback development and the test daemons are HTTP. The daemon reads the cookie only under its
origin's name, and an HTTPS sign-in clears a cookie left under the plain name. Deploying the change
signs everyone out once (operator decision 2026-10-12).
