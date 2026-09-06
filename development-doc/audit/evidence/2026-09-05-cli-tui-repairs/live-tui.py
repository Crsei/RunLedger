import os,subprocess,json,pathlib,sys,time,shlex
root=pathlib.Path('/tmp/runledger-command-repair-20260905/live-tui')
root.mkdir(exist_ok=True)
case=sys.argv[1]; action=sys.argv[2]; work=root/case; work.mkdir(exist_ok=True)
socket='rl-audit-live-'+case+'-repair20260905'
env={k:v for k,v in os.environ.items() if k in ['PATH','LANG','LC_ALL','TERM','COLORTERM','SHELL','USER','LOGNAME']}
for d in ['home','state','config','data']: (work/d).mkdir(exist_ok=True)
env.update(HOME=str(work/'home'),RUNLEDGER_DIR=str(work/'state'),XDG_CONFIG_HOME=str(work/'config'),XDG_DATA_HOME=str(work/'data'),TERM='xterm-256color')
# 凭据只从继承环境传入子进程，不写文件/日志。
env['AZURE_OPENAI_API_KEY']='audit-dummy-key' if case.startswith('fixture') else os.environ['AZURE_OPENAI_API_KEY']
env['AZURE_OPENAI_ENDPOINT']=os.environ.get('AZURE_OPENAI_ENDPOINT','https://unused.invalid')
if case!='original': env['AZURE_OPENAI_BASE_URL']=os.environ.get('AZURE_OPENAI_ENDPOINT','https://unused.invalid')
if os.environ.get('OPENAI_API_VERSION'): env['AZURE_OPENAI_API_VERSION']=os.environ['OPENAI_API_VERSION']
if case.startswith('fixture'):
 env['AZURE_OPENAI_BASE_URL']='http://127.0.0.1:'+pathlib.Path('/tmp/runledger-command-repair-20260905/fixture-port.txt').read_text()+'/openai/v1'
 env['AZURE_OPENAI_API_VERSION']='v1'
def tm(*args,check=True):
 r=subprocess.run(['tmux','-L',socket,*args],env=env,text=True,capture_output=True,timeout=8)
 if check and r.returncode: raise RuntimeError(r.stderr)
 return r.stdout
if action in ('start','resume'):
 (work/'state'/'settings.json').write_text(json.dumps({'provider':'azure-openai-responses','model':'gpt-4.1-mini','thinkingLevel':'off'}))
 tm('new-session','-d','-s','test','-x',os.environ.get('AUDIT_COLS','120'),'-y',os.environ.get('AUDIT_ROWS','38'),'-c','/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger','sleep 3600')
 tm('set-window-option','-t','test','remain-on-exit','on')
 tm('respawn-pane','-k','-t','test','exec /home/nzq/.npm-global/bin/runledger --provider azure-openai-responses --model gpt-4.1-mini --thinking off'+(' --continue' if action=='resume' else ''))
 print(json.dumps({'socket':socket,'pid':tm('display-message','-p','-t','test','#{pane_pid}').strip()}))
elif action=='send':
 tm('send-keys','-t','test','-l','--',sys.argv[3]); tm('send-keys','-t','test','Enter'); print('sent')
elif action=='key':
 tm('send-keys','-t','test',*sys.argv[3:]); print('sent keys')
elif action=='capture':
 frame=tm('capture-pane','-p','-t','test','-S','-250'); (work/(sys.argv[3]+'.txt')).write_text(frame); print(frame)
 print('PANE_STATE='+tm('display-message','-p','-t','test','#{pane_dead}|#{pane_dead_status}|#{pane_pid}').strip())
elif action=='stop':
 print(tm('kill-server',check=False))
