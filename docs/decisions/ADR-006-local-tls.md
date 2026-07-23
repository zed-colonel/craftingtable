# ADR-006 — Local TLS deployment

- **Status:** deferred
- **Date:** 2026-07-23

## Context

LAN exposure with authenticated TLS (reverse proxy, private DNS, `systemd` user service) is a CT-08 concern. CT-01 must not create a security boundary it cannot enforce.

## Decision

Deferred until CT-08. The CT-01 server binds `127.0.0.1:4600` only; nothing listens on LAN interfaces, and no TLS or proxy configuration exists in the repository.

## Notes for the future decision

The architectural requirement is authenticated TLS before normal MacBook use, likely via Caddy or equivalent in front of the loopback daemon. Authentication (CT-02) must land first.
