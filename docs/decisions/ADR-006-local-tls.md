# ADR-006 — Local TLS deployment

- **Status:** deferred
- **Date:** 2026-07-23
- **Reviewed:** 2026-07-24 for CT-02

## Context

LAN exposure with authenticated TLS (reverse proxy, private DNS, `systemd` user service) is a CT-08 concern. CT-02 authentication does not authorize network exposure.

## Decision

Deferred until CT-08. The CT-02 server remains loopback-only; nothing listens on LAN interfaces, and no TLS or proxy configuration exists in the repository. This is enforced, not just documented: `configFromEnv` rejects any non-loopback `CRAFTINGTABLE_HOST` value (`127.0.0.1`, `localhost`, and `::1` are the only accepted hosts), preserving review finding CT01-R1.

## Notes for the future decision

The architectural requirement is authenticated TLS before LAN use, likely via Caddy or equivalent in front of the loopback daemon. Cookie `Secure` behavior is already derived from the configured public origin, but CT-02 itself supports only loopback operation.
