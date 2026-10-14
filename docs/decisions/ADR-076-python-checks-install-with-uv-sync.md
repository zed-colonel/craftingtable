# ADR-076: Python checks install with uv sync

- **Status:** accepted
- **Date:** 2026-10-14
- **Supersedes:** ADR-074 (the daemon's wheel store, and how a Python check's environment is built)
- **Refines:** ADR-053, ADR-075

## Context

ADR-074 built a Python check's environment with no network from wheels the daemon fetched and
verified itself: the daemon read the adopted `uv.lock`, downloaded each fitting wheel from PyPI,
kept it only when its bytes matched both PyPI's digest and the lock's hash, and uv installed those
offline, building nothing. That needed a third kind of outbound request, a 20 GiB store, its own
fetch limits and wheel-tag matching, and it refused packaged projects (no console scripts) and any
package with only a source distribution.

Under ADR-075 CraftingTable defends against accidents and unverified claims, not a deliberately
hostile agent. What the store added beyond uv's own hash checks guarded against an agent poisoning
a cache or PyPI's answers, not against accidents, and its limits cost real projects: Slopinator's
next step is a packaged project with console scripts (R-G19).

## Decision

**An install step builds each Python check's venv with `uv sync --locked`.** For an adopted check
of a reviewed commit with a root `uv.lock`, after the toolchain's re-read (unchanged from
ADR-074):

- **The lock is read with no network,** by the profile's interpreter (`tomllib`), and refused by
  name when it names anything but PyPI and the tree: a Git or URL source, another registry, a file
  of a PyPI package off `files.pythonhosted.org` or without a SHA-256, a path outside the
  repository. PyPI packages with wheels or only a source distribution, the project itself
  (packaged or virtual), workspace members and paths inside the tree are taken.
- **The install** runs `uv sync --locked --python <profile>` in the reviewed clone, into a fresh
  venv in the check's private directory (`UV_PROJECT_ENVIRONMENT`), with no configuration of the
  tree's or the operator's (`UV_NO_CONFIG`) but the resolver options the lock records
  (`exclude-newer` and `exclude-newer-package`, `resolution`, `prerelease`, `fork-strategy`), passed
  as flags so that the lock still matches (one it cannot pass is refused by name), no Python
  downloads, copies rather than links into the venv, and a fixed environment. uv refuses a lock that
  no longer matches the project and checks every file against the lock's hashes; it builds what
  needs building (the project with its build backend, source distributions), so the project's
  console scripts exist. It runs in its own systemd unit with the network, which may write the
  check's Python directory, the clone (a build in the tree) and uv's cache, and sees nothing else of
  what agents write, no Docker socket and nothing of the user's runtime directory, within what is
  left of the check's time limit.
- **uv's cache for installs is the daemon's own,** `<data>/uv/checks`, shared by checks and written
  by no agent: not the agents' `<data>/uv/cache`, which their venvs may link into. The daemon
  empties it at each start, before any check runs.
- **The check then runs as before:** offline, in a unit with no network, with the venv first on
  PATH and read-only, uv offline, frozen and not syncing, and no Python or uv setting inherited.
  The venv is removed when the check ends; none is reused.
- **Receipts** keep the tools' identities, the profile's digest and the lock's digest; the wheel
  set's digest goes, with the store.
- **Adoption is unchanged:** every check names each Python environment file its commit tracks,
  `uv.lock` and `pyproject.toml` included, and a change to one is `check-definition-changed`.

**The install's network is not narrowed to PyPI's hosts.** A systemd user manager does not enforce
`IPAddressAllow`/`IPAddressDeny` ("unit configures an IP firewall, but not running as root"; checked
2026-10-14: a unit with `IPAddressDeny=any` reached `example.com`), and PyPI's hosts are a CDN's
addresses in any case. Narrowing it would take a proxy of the daemon's own, bridged into a private
network namespace, which is more than a simple mechanism, so ADR-075's fallback applies: the install
step alone has the network. uv fetches the lock's packages only from PyPI and the tree, because the
lock is refused otherwise and no configuration points it elsewhere; build requirements come from
PyPI unless the project's or a source distribution's `[build-system] requires` names a direct URL or
its `tool.uv.sources` names another source for one, which uv follows (R-G19 review MEDIUM-2); and a
build the install runs (a `setup.py`, a build backend) can reach any host, as it can in the agent's
own `uv sync`.

**The daemon's wheel store is retired,** and with it its outbound request: the daemon's own
requests are Pushover and crates.io's index again.

## Consequences

- Packaged projects, console scripts and source distributions work in checks, as they do in the
  agents' worktrees.
- What a check's environment guarantees: the root-owned interpreter and uv, the adopted lock, and
  that each locked file from PyPI matched the lock's hash. Build requirements (`[build-system]
  requires`) are not in `uv.lock` and are not hashed: uv resolves them at install time, by its own
  rules, from PyPI or from a source the project or a source distribution names for them. A project's
  `[tool.uv] dependency-metadata`, which no flag carries, is refused by name, and `no-sources` is
  not supported. What a build runs is the tree's code, the reviewer's, as tests and `conftest.py`
  are.
- A source distribution whose build needs a tool outside `/usr/bin` (rustup's Cargo, Go) fails
  in the install, whose `PATH` is `/usr/bin:/bin` with the home hidden, though it builds in an
  agent's `uv sync`.
- A check's install needs PyPI to be reachable, or every file in uv's check cache; the first check
  of a new lock downloads what the agents already fetched.
- `<data>/uv/checks` grows with every check, since each builds its project from a clone of its own
  and uv keeps each build (`uv cache prune` reclaims none of them; R-G19 review LOW-2); the
  daemon's start empties it, so a check after a restart downloads again. A daemon from before
  R-G19 left `<data>/pypi-wheels`, which nothing reads any more.

## Alternatives considered

- **Keep the store and add source builds:** keeps the third outbound request and the store's
  limits, and the store vouches for nothing uv's hash check does not, under ADR-075.
- **Narrow the install's network** with a CONNECT proxy for PyPI's two hosts, reached through a
  Unix socket bridged into a unit with no network: possible, but a new daemon component, a socket
  bridge in every install and tests of both, to stop routes only a hostile build would take.
- **The agents' shared uv cache** (R-G19 allowed it): saves downloads, but uv links an agent's
  venv into that cache where the file system cannot clone (on ext4, as this workstation's data
  disk is, a venv's files are hard links to the cache's; checked 2026-10-14 with uv 0.12.22), so an
  agent editing a file in its `.venv` in place would change what the next check installs. Checks
  keep a cache of their own and copy from it.
- **A non-editable install** (`--no-editable`): would copy the project into the venv; the default
  editable install matches the agents' `uv sync`, and the check runs the reviewed tree either way.
