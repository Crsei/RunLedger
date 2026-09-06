from pathlib import Path
import os,re,sys,subprocess,json,time,shutil
b=Path(__file__).parent
label=sys.argv[1]
files=sys.argv[2:]
root=b/(label+'-home');root.mkdir(exist_ok=True)
tmp=b/(label+'-temp');tmp.mkdir(exist_ok=True)
env={k:v for k,v in os.environ.items() if not re.search(r'(?:API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|AWS_|AZURE_|GOOGLE_|OPENAI_|ANTHROPIC_|RUNLEDGER_)',k,re.I)}
env.update(HOME=str(root),RUNLEDGER_DIR=str(root),TMPDIR=str(tmp),XDG_CONFIG_HOME=str(root/'config'),XDG_DATA_HOME=str(root/'data'),CI='1')
argv=['node','--import','tsx','scripts/run-test-buckets.ts','--mode','all','--evidence-file',str(b/(label+'-evidence.json'))]
for f in files:argv+=['--file',f]
start=time.time()
with (b/(label+'.log')).open('w') as log:
 p=subprocess.run(argv,env=env,stdout=log,stderr=subprocess.STDOUT)
result={'argv':argv,'cwd':str(Path.cwd()),'exitCode':p.returncode,'elapsedSeconds':round(time.time()-start,3)}
(b/(label+'-invocation.json')).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
print((b/(label+'.log')).read_text()[-16000:])
shutil.rmtree(root);shutil.rmtree(tmp)
