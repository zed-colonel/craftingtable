#!/usr/bin/env python3
"""Install a dedicated Kata host from a SHA-256 verified official archive. Run as root.
Does not grant users access to the root containerd socket or change existing runtimes.
"""
import argparse, hashlib, json, os, pathlib, pwd, shutil, subprocess
p=argparse.ArgumentParser()
p.add_argument('--archive',required=True);p.add_argument('--sha256',required=True)
p.add_argument('--storage-mount',required=True);p.add_argument('--owner',required=True)
a=p.parse_args()
if os.geteuid()!=0: raise SystemExit('Run this installer as root.')
mount=pathlib.Path(a.storage_mount)
if not mount.is_mount() or mount.is_symlink(): raise SystemExit('Storage must be an existing real mount point.')
owner=pwd.getpwnam(a.owner)
archive=pathlib.Path(a.archive)
# Copy verified bytes into root-only storage before extracting; never execute user-owned binaries as root.
base=mount/'craftingtable-kata'
for path in [pathlib.Path('/opt/kata'),pathlib.Path('/etc/containerd/craftingtable-kata.toml'),pathlib.Path('/etc/systemd/system/craftingtable-kata.service'),base]:
 if path.exists() or path.is_symlink(): raise SystemExit(f'Refusing to overwrite existing {path}')
if len(a.sha256)!=64: raise SystemExit('Expected exact release SHA-256.')
# Preserve the named owner's write access while preventing replacement of root-owned children.
os.chown(mount,0,owner.pw_gid);os.chmod(mount,0o1775)
base.mkdir(mode=0o700)
copy=base/'release.tar.zst';shutil.copyfile(archive,copy)
if hashlib.file_digest(copy.open('rb'),'sha256').hexdigest()!=a.sha256: raise SystemExit('Release digest mismatch.')
# Extract only the release's opt/kata subtree into root-owned, non-user-replaceable storage.
stage=base/'release';stage.mkdir(mode=0o700)
subprocess.run(['tar','--zstd','-xf',str(copy),'-C',str(stage),'--no-same-owner'],check=True)
runtime=stage/'opt/kata'
if not (runtime/'bin/kata-runtime').is_file(): raise SystemExit('Unexpected Kata archive layout.')
# The runtime needs normal execute permissions through parents for read-only diagnostics.
os.chmod(base,0o755);os.chmod(stage,0o755)
pathlib.Path('/opt/kata').symlink_to(runtime,target_is_directory=True)
(base/'data').mkdir(mode=0o700)
config=pathlib.Path('/etc/containerd/craftingtable-kata.toml');config.parent.mkdir(exist_ok=True)
config.write_text(f'''version = 3
root = {json.dumps(str(base/'data'))}
state = "/run/craftingtable-kata/state"
disabled_plugins = ["io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime"]
[grpc]
  address = "/run/craftingtable-kata/containerd.sock"
  uid = 0
  gid = 0
''')
unit=pathlib.Path('/etc/systemd/system/craftingtable-kata.service')
unit.write_text(f'''[Unit]
Description=CraftingTable dedicated Kata containerd
RequiresMountsFor={mount}
After=network-online.target
[Service]
Type=notify
ExecStartPre=/usr/bin/modprobe vhost_vsock
ExecStart=/usr/bin/containerd --config /etc/containerd/craftingtable-kata.toml
Environment=PATH=/opt/kata/bin:/usr/local/sbin:/usr/local/bin:/usr/bin
Environment=KATA_CONF_FILE=/opt/kata/share/defaults/kata-containers/configuration-qemu.toml
RuntimeDirectory=craftingtable-kata
RuntimeDirectoryMode=0700
UMask=0077
Delegate=yes
KillMode=process
Restart=on-failure
[Install]
WantedBy=multi-user.target
''')
subprocess.run(['modprobe','vhost_vsock'],check=True)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','craftingtable-kata.service'],check=True)
subprocess.run(['/opt/kata/bin/kata-runtime','--config','/opt/kata/share/defaults/kata-containers/configuration-qemu.toml','check'],check=True)
copy.unlink()
print('Installed dedicated Kata service. Root socket access is restricted. A guest smoke test is still required.')
