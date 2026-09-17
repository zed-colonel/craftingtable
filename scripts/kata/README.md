# Dedicated Kata workstation setup

`setup-host.py` installs a verified official Kata Go runtime archive and a separate
`craftingtable-kata` containerd service. Review the script before running it as root.
It refuses existing destinations. Use a stable release and the exact published asset
SHA-256. It does not change Docker, existing containerd configuration or user groups.

The supplied storage mount must already exist. Its top directory becomes root-owned,
group-owned by the named owner, mode 1775: the owner retains write access, while the
sticky bit prevents replacement of root-owned Kata storage. All existing child contents
are untouched. The private root daemon socket grants no ordinary-user execution rights.

Example (replace the placeholders with verified release values and local storage):

```sh
sudo python3 scripts/kata/setup-host.py --archive /path/to/verified-release.tar.zst \
  --sha256 RELEASE_SHA256 --storage-mount /path/to/storage --owner YOUR_USER
sudo python3 scripts/kata/smoke-host.py --image docker.io/library/busybox@sha256:IMAGE_DIGEST \
  --receipt /path/to/storage/craftingtable-kata/readiness.json
```

The smoke script uses a private containerd namespace and an explicit Kata runtime, records
the guest and host kernels and verifies cleanup. Retain its root-owned receipt and set
`CRAFTINGTABLE_KATA_READINESS` in the CraftingTable daemon environment to show the result
in workstation audits. This is infrastructure readiness, not application conformance or
permission for agents to access root containerd. Native checks do not require Kata.

Stopping `craftingtable-kata` removes availability; disabling it prevents boot startup.
Retain image/kernel/runtime provenance for reproduction. Remove obsolete release downloads
and staging copies after installation; never prune active guest data or other runtimes.
