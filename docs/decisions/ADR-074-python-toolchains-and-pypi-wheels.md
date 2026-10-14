# ADR-074: Python toolchains and PyPI wheels for checks

- **Status:** accepted
- **Date:** 2026-10-13
- **Refines:** ADR-053

## Context

Slopinator, the first Python project to run in CraftingTable, is a uv project: a virtual root
project with a `uv.lock`, Python `>=3.12,<3.13`, and CPU dependencies that all ship wheels
(R-G17). The daemon knew no Python toolchain. Checks took the daemon's PATH minus agent-writable
entries, the host's only Python was the rolling release's 3.14, and uv came from mise under the
operator's home, which agents can write because they run as the operator. Outside sources were
Cargo's only, and Cargo's check-side model did not carry over: Cargo checks copy the agents'
downloaded `.crate` files and verify them against crates.io's index, but uv's cache holds
unpacked wheels, so nothing of the agents' could be verified. Check units had no resource caps.

The operator's 17 decisions of 2026-10-13 are in R-G17's entry. This records the trust model they
produced.

## Decision

**The toolchain is a trust root the operator installs as root.** CPython and uv live under
`/opt/craftingtable`, installed as root by the operator; `toolchains.json` in the settings
directory names them, with the version each must fit, and optionally FFmpeg, ffprobe and font
files, recorded by identity, and the check units' caps.

- **The rule.** Every configured tool must be an absolute, normalized path to a regular file
  that root owns and no group or other user may write, with every directory above it the same
  and no link anywhere on the way; a Python interpreter's prefix and standard library
  directories too. Anything the operator's account can write could otherwise become a check's
  privileged configuration, because agents run as that account. This is stricter than Rust's
  toolchain, which lives in the operator's `~/.rustup`.
- **At start** the daemon validates the file, as it does `outside-sources.json`: it refuses to
  start on a file it cannot take whole, a tool that breaks the rule, or a tool inside the data
  directory or a root agents write. It runs no tool to do so.
- **Fixed probes** then record each tool's real path, owner, mode, size, SHA-256 and version
  (`python -I -S -c <fixed>` for version, platform and the host's C library; `uv --version`;
  `ffmpeg -version`), through the supervised process spawner, with a fixed environment and no
  input. A probe that fails is shown, and the start goes on.
- **Every Python check re-reads them** and records the identities in its receipt. A check is
  refused when a tool is missing, no longer root-owned, writable by others, or no longer fits its
  configured version, a dotted prefix (`3.12` takes 3.12.x). An update the operator installs that
  still fits is recorded, not refused: Omarchy is a rolling release, and receipts already recorded
  stay valid. Tools shows each identity and what changed and when since the daemon started; the
  receipts are the lasting record.

**Every check unit is capped.** MemoryMax (8 GB by default, as the native unit), no swap, and
TasksMax (1024 by default: sixteen times the 64-task peak of WorldInterface's heaviest adopted
check on a 16-core workstation, where Cargo's and the test harnesses' parallelism follow the core
count). `toolchains.json` may set both.

**Wheels: the lock selects, PyPI vouches.** *(Built in increment 2; see R-G17.)*

- Agents fetch through a `pypi` outside source: `pypi.org` and `files.pythonhosted.org` only,
  into one daemon-owned uv cache shared by all agents, with the profile's uv first on PATH and
  `UV_PYTHON_DOWNLOADS=never`. Checks never read that cache.
- The daemon downloads the wheels a check needs itself, from PyPI's JSON API and
  `files.pythonhosted.org` only, with redirects refused, a per-file size cap, a rate window and a
  store budget. It keeps a file, by SHA-256, under the data directory only when its bytes match
  both PyPI's published digest and the lock's hash. Git, URL, path, other-index and sdist-only
  packages are refused by name. This is the daemon's third kind of outbound request, after
  Pushover and crates.io's index.

**Checks: a fresh, offline environment from verified wheels.** *(Built in increment 3; see
R-G17.)* A check gets Python when the reviewed commit has a root `uv.lock` and a Python profile
is configured. A helper unit with no network builds a fresh venv in the check's private
directory, copying the verified wheels in and hashing them again; the check then runs with the
venv first on PATH, uv held offline and frozen, and the venv and toolchain read-only. Adoption
covers Python environment and tool configuration files at any depth, as it covers Cargo's; tests
and `conftest.py` stay the reviewer's. Only virtual projects are supported, so nothing of the
tree is installed. A check may have both the venv and a verified Cargo home.

## Consequences

- A Python project's adopted checks run on interpreters, wheels and tools the agents cannot
  change: the toolchain is root's, the wheels are PyPI's bytes that the adopted lock names, and
  the environment is built fresh for each check.
- PyPI is trusted as the publisher of record, as crates.io's index is for crates: a package
  compromised at PyPI with its digest updated still needs the adopted lock to name that digest.
  The lock is agent-written, but changing it is a `check-definition-changed` stop until a person
  adopts it.
- An operator update of CPython or uv inside its configured version takes effect for the next
  check without a restart, recorded on Tools and in receipts; one outside it refuses Python checks
  until `toolchains.json` names it and the daemon restarts.
- Hosts without the toolchain run no Python checks; nothing else changes for them. No persisted
  format changes: the profile reaches checks through the run's manifest, and the identities
  through receipts, both of which already carried free-form JSON.
