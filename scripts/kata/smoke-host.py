#!/usr/bin/env python3
"""Root-only disposable Kata readiness test, not application conformance evidence."""
import argparse,datetime,json,os,pathlib,subprocess,uuid
p=argparse.ArgumentParser();p.add_argument('--image',required=True);p.add_argument('--receipt',required=True);a=p.parse_args()
if os.geteuid()!=0 or '@sha256:' not in a.image: raise SystemExit('Root and a digest-pinned image are required.')
base=['/usr/bin/ctr','--address','/run/craftingtable-kata/containerd.sock','--namespace','craftingtable-readiness']
id='ct-smoke-'+uuid.uuid4().hex
result={'version':1,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime':'io.containerd.kata.v2','image':a.image,'hostKernel':os.uname().release,'container':id,'success':False}
def run(args,timeout=180): return subprocess.run(base+args,text=True,capture_output=True,timeout=timeout)
try:
 pull=run(['images','pull',a.image]);result['pullExit']=pull.returncode
 if pull.returncode: raise RuntimeError(pull.stderr)
 task=run(['run','--runtime','io.containerd.kata.v2','--rm',a.image,id,'/bin/uname','-r'],90)
 result.update(exitCode=task.returncode,guestKernel=task.stdout.strip(),diagnostic=task.stderr[-16000:])
 if task.returncode or not task.stdout.strip() or task.stdout.strip()==os.uname().release: raise RuntimeError('Guest launch did not establish a separate kernel.')
 result['success']=True
except Exception as e: result['error']=str(e)
finally:
 for args in [['tasks','kill','--signal','SIGKILL',id],['tasks','delete','--force',id],['containers','delete',id]]:
  try: run(args,20)
  except Exception as e: result['cleanupError']=str(e)
 remaining=run(['containers','list','--quiet'],20);tasks=run(['tasks','list'],20)
 result['cleanupPassed']=remaining.returncode==0 and tasks.returncode==0 and id not in remaining.stdout and id not in tasks.stdout
 result['success']=result['success'] and result['cleanupPassed'] and not result.get('cleanupError')
 path=pathlib.Path(a.receipt)
 if path.is_symlink(): raise SystemExit('Receipt must not be a symlink.')
 path.write_text(json.dumps(result,indent=2));os.chmod(path,0o644)
 print(json.dumps(result,indent=2))
raise SystemExit(0 if result['success'] else 1)
