# Local GitHub Actions checks

Install `act` and configure a Docker-compatible engine. Rootless Docker avoids granting the
CraftingTable account root-equivalent membership in the system Docker group. Keep the daemon's
image/container store on the large storage volume as well as act's caches. For Docker 29's
containerd image store, verify containerd's actual root too; changing Docker's data root does
not relocate an independently managed system containerd.

Build the runner with an explicitly selected base digest:

```sh
docker build --build-arg RUNNER_IMAGE=ghcr.io/catthehacker/ubuntu@sha256:REPLACE_WITH_SELECTED_DIGEST \
  -t craftingtable-ci:rust-1.89 -f scripts/local-ci/Dockerfile scripts/local-ci
docker image inspect craftingtable-ci:rust-1.89 --format '{{json .RepoDigests}}'
```

Set `CRAFTINGTABLE_ACT_CONFIG` in the daemon environment to a private installation JSON file:

```json
{
  "actExecutable": "/usr/bin/act",
  "dockerExecutable": "/usr/bin/docker",
  "dockerHost": "unix:///run/user/1000/craftingtable-docker.sock",
  "image": "craftingtable-ci@sha256:REPLACE_WITH_BUILT_DIGEST",
  "cacheRoot": "/your-large-volume/craftingtable/ci/cache"
}
```

The socket and paths are installation choices, not project settings. The daemon copies the
validated configuration into each run's immutable manifest. Restart to change the installation
environment. No automatic agent launch or plan acceptance is involved. The runner image includes
Rust 1.89.0, rustfmt, clippy, Python, Node and native build prerequisites. Pin other toolchains in
the repository workflow when required. Ubuntu labels map to the selected image, not separate VMs.

Scoped agents receive:

```sh
ct-check -- python3 scripts/check-contracts.py
ct-check -- bash scripts/ci.sh
ct-act -W .github/workflows/ci.yml -j contracts
```

The scripts/workflows belong to the supervised repository and must actually exist. Both local
and hosted workflows should call those same scripts. A successful narrow job does not waive any
other required checks. The original WI/EXO workflows are legacy full-runtime workflows, not an
appropriate automatic substitute for the new contract-only opening scope.

For local act jobs, the controller supplies:

- `CRAFTINGTABLE_DEPENDENCY_MANIFEST`: exact source identities, paths, hashes and verification policy.
- `CRAFTINGTABLE_CARGO_CONFIG`: Cargo patches to the controller-exported dependency sources.
- `CRAFTINGTABLE_VERIFICATION_MODE`: scoped checks or current-upstream build.
- `CRAFTINGTABLE_CI_ARTIFACTS_DIR`: retained directory for script-produced logs/artifacts.
- `CARGO_TARGET_DIR`: disposable run scratch outside the source checkout.

All manifest paths are mounted at the same absolute location. Managed-worktree Git metadata
is mounted read-only so Git/version checks work without granting CI branch-update authority. A repository CI script can use:

```bash
cargo_options=()
if [[ -n "${CRAFTINGTABLE_CARGO_CONFIG:-}" ]]; then
  cargo_options+=(--config "$CRAFTINGTABLE_CARGO_CONFIG")
fi
cargo "${cargo_options[@]}" test --locked -p the_relevant_domain_crate
```

On GitHub, provision the exact upstream commits from the repository-owned dependency lock and
run that same script. The repository must implement that hosted provisioning explicitly; local
mounts are not GitHub artifacts, and private checkout credentials are never inferred from agent
logins. Do not use moving branches or silently fall back to registry versions.

Local CI records workflow output and clean-commit provenance. Integration reviews additionally
run the host controller Cargo launcher, whose resolution checks supply the required pinned build
receipt. Local CI logs alone cannot replace it or qualify a native/Kata environment.

The adapter disables implicit `.env`, `.secrets`, `.vars`, `.input` and home `.actrc` configuration;
selects one workflow/job; limits jobs to one at a time, four CPUs and 8 GiB; and bounds a command
by the smaller of 30 minutes and the cycle's step allowance. The outer agent deadline still applies.
No Docker socket is mounted into jobs. Cancellation removes this run's labelled job containers;
interrupted collection requires a fresh review. Docker-action/service behavior remains subject to
act's limitations; this is intended for ordinary repository script/JavaScript-action CI.

Action code and Cargo registry/Git downloads are cached on the configured volume. GitHub's cache
server is disabled; use these local download caches rather than depending on `actions/cache`.
Write local artifacts to the supplied directory rather than `upload-artifact`. Image layers and
shared downloads are retained. Inspect them using the selected rootless engine and reclaim unused
images/build caches deliberately; never globally prune while CraftingTable has active CI work.

References: [act runners](https://nektosact.com/usage/runners.html),
[act limitations](https://nektosact.com/not_supported.html),
[Docker rootless mode](https://docs.docker.com/engine/security/rootless/).
