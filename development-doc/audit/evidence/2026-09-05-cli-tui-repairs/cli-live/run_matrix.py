import os,json,pathlib,subprocess,signal,time,hashlib,datetime,re
BASE=pathlib.Path('/tmp/runledger-command-repair-20260905/cli-live')
REPO=pathlib.Path('/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger')
EXE=pathlib.Path('/home/nzq/.npm-global/bin/runledger')
assert EXE.resolve()==REPO/'bin/runledger.js'
BASE.mkdir(parents=True,exist_ok=True)
results=[]

def fixture(name):
 root=BASE/name
 for suffix in ['user','state','config','data','cache','runtime','workspace']:
  (root/suffix).mkdir(parents=True,exist_ok=True,mode=0o700)
 return {'root':root,'home':root/'state','cwd':REPO,'env':{'PATH':os.environ['PATH'],'HOME':str(root/'user'),'RUNLEDGER_DIR':str(root/'state'),'XDG_CONFIG_HOME':str(root/'config'),'XDG_DATA_HOME':str(root/'data'),'XDG_CACHE_HOME':str(root/'cache'),'XDG_RUNTIME_DIR':str(root/'runtime'),'TERM':'dumb','LANG':'C.UTF-8','NO_COLOR':'1','SHELL':'/bin/bash'}}

def record_case(ident,args,fixture,exit_code,ok=None,operation=None,stderr_contains=None,timeout=20):
 start=time.monotonic();timed_out=False
 proc=subprocess.Popen([str(EXE),*args],cwd=fixture['cwd'],env=fixture['env'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 try:out,err=proc.communicate(timeout=timeout)
 except subprocess.TimeoutExpired:
  timed_out=True;os.killpg(proc.pid,signal.SIGTERM)
  try:out,err=proc.communicate(timeout=2)
  except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);out,err=proc.communicate()
 out=out.decode(errors='replace');err=err.decode(errors='replace')
 checks={'exit':proc.returncode==exit_code,'bounded_completion':not timed_out}
 body=None
 if ok is not None or operation is not None:
  try:body=json.loads(out)
  except ValueError:checks['json']=False
  if isinstance(body,dict):
   if ok is not None:checks['ok']=body.get('ok')==ok
   if operation is not None:checks['operation']=body.get('operation')==operation
  else:checks['json']=False
 if stderr_contains is not None:checks['stderr']=stderr_contains in err
 result={'id':ident,'argv':[str(EXE),*args],'cwd':str(fixture['cwd']),'runledger_dir':str(fixture['home']),'pid':proc.pid,'exit_code':proc.returncode,'timeout':timed_out,'duration_seconds':round(time.monotonic()-start,3),'expected':{'exit_code':exit_code,'ok':ok,'operation':operation,'stderr_contains':stderr_contains},'checks':checks,'pass':all(checks.values()),'stdout':out,'stderr':err}
 results.append(result);save();print(json.dumps({k:result[k] for k in ['id','exit_code','pass','duration_seconds']}),flush=True)
 (BASE/f'{ident}.stdout.txt').write_text(out);(BASE/f'{ident}.stderr.txt').write_text(err)
 return result

def save():
 (BASE/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))

def policy(fixture):
 p=fixture['home']/'settings.json'
 if not p.exists():return None
 return json.loads(p.read_text()).get('skills')

metadata={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'executable':str(EXE),'real_executable':str(EXE.resolve()),'dist_main_sha256':hashlib.sha256((REPO/'dist/cli/main.js').read_bytes()).hexdigest(),'provider_credentials':'No provider credentials inherited or configured; controlled commands only. No external model requests.','repository_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()}
(BASE/'metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
f=fixture('controls')
record_case('help',['--help'],f,0)
record_case('version',['--version'],f,0)
record_case('workspace_capability',['workspace','capability'],f,0)
record_case('security_inspect',['security','inspect'],f,0,True,'session.security.inspect')
record_case('skill_provider_list',['skill','provider','list'],f,0,True,'skill.provider.list')
r=record_case('skill_provider_disable_user',['skill','provider','disable','runledger-user','--scope','user'],f,0,True,'skill.provider.disable')
r['checks']['persisted_disabled']=policy(f)=={'enabled':True,'providers':{'runledger-user':False}};r['pass']=all(r['checks'].values());save()
r=record_case('skill_provider_enable_user',['skill','provider','enable','runledger-user','--scope=user'],f,0,True,'skill.provider.enable')
r['checks']['persisted_enabled']=policy(f)=={'enabled':True,'providers':{'runledger-user':True}};r['pass']=all(r['checks'].values());save()
user_before=policy(f)
r=record_case('skill_provider_workspace_rejected',['skill','provider','disable','runledger-user','--scope=workspace'],f,1,False,'skill.provider.disable')
r['checks']['user_policy_preserved']=policy(f)==user_before;r['pass']=all(r['checks'].values());save()
record_case('skill_provider_missing_scope',['skill','provider','disable','runledger-user','--scope'],f,2,stderr_contains='--scope 缺少值')
record_case('plugin_reload',['plugin','reload'],f,0,True,'extension.reload')
record_case('plugin_list',['plugin','list'],f,0,True,'plugin.list')
record_case('mcp_list',['mcp','list'],f,0,True,'mcp.list')
record_case('mcp_doctor',['mcp','doctor'],f,0,True,'mcp.doctor')
record_case('memory_query_unavailable',['memory','search','audit-no-match'],f,1,False,'memory.search')
record_case('remember_documented',['remember','audit-note'],f,1,False,'memory.inspect')
record_case('remember_explicit',['remember','propose','audit-note'],f,1,False,'memory.inspect')
record_case('plan_inspect',['plan','inspect'],f,0,True,'plan.inspect')
record_case('plan_mutation_unavailable',['plan','enter'],f,1,False,'plan.enter')
record_case('gateway_status_missing',['auth-gateway','status','--json'],f,0,True)
record_case('gateway_check_missing',['auth-gateway','check','--json'],f,1,False)
(f['home']/'auth-gateway.token').write_text('a'*43+'\n');(f['home']/'auth-gateway.token').chmod(0o600)
record_case('gateway_check_configured',['auth-gateway','check','--json'],f,0,True)
record_case('manifest_missing_confirmation',['storage','prune-legacy','--manifest','0'*64],f,2,stderr_contains='需要显式 --confirm-delete')
for spelling in ['spaced','equals']:
 mf=fixture('prune-'+spelling);mf['cwd']=mf['root']/'workspace'
 source=mf['home']/'sessions/2026/09/05/audit.jsonl';source.parent.mkdir(parents=True,mode=0o700)
 sid='session_cli-live-'+spelling
 header={'type':'ledger','id':'event_cli-live-header','createdAt':1752000000000,'sessionId':sid,'metadata':{'cwd':str(mf['cwd'])}}
 entry={'id':'event_cli-live-message','sessionId':sid,'parentId':'event_cli-live-header','timestamp':1000,'type':'message','payload':{'role':'user','content':[{'type':'text','text':'CLI isolated archive fixture'}]}}
 source.write_text(json.dumps(header)+'\n'+json.dumps(entry)+'\n');source.chmod(0o600)
 mr=record_case('migrate_'+spelling,['migrate','session-store','--confirm-archive'],mf,0,timeout=25)
 match=re.search(r'manifest=([a-f0-9]{64})',mr['stdout'])
 mr['checks']['manifest_emitted']=match is not None;mr['checks']['source_archived']=not source.exists();mr['pass']=all(mr['checks'].values());save()
 if match:
  digest=match.group(1);args=['storage','prune-legacy']+(['--manifest',digest] if spelling=='spaced' else ['--manifest='+digest])+['--confirm-delete']
  pr=record_case('prune_'+spelling,args,mf,0)
  pr['checks']['archive_deleted']=not (mf['home']/'migration-backup/session-store'/digest).exists();pr['pass']=all(pr['checks'].values());save()
summary={'cases':len(results),'passed':sum(r['pass'] for r in results),'failed':[r['id'] for r in results if not r['pass']],'timeouts':sum(r['timeout'] for r in results),'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(BASE/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps(summary),flush=True)
raise SystemExit(0 if not summary['failed'] else 1)
