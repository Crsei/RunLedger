import subprocess,time,pathlib,json
root=pathlib.Path('/tmp/runledger-command-repair-20260905');case='fixture-final';socket='rl-audit-live-'+case+'-repair20260905';work=root/'live-tui'/case
rows=[]
def tm(*args):return subprocess.run(['tmux','-L',socket,*args],text=True,capture_output=True,check=True,timeout=8).stdout
def send(text):tm('send-keys','-t','test','-l','--',text);tm('send-keys','-t','test','Enter')
def capture():return tm('capture-pane','-p','-t','test','-S','-250')
questions=[('请只回答数字：2 + 2 等于多少？','\n4\n','done:stop'),('上一轮回答是什么？请简短回答。','上一轮回答：4','done:stop'),('请调用 read 读取当前项目 package.json 的前六行。','"name": "runledger"','done:stop'),('请执行命令 printf audit-ok，并报告输出。','EXIT: 0','done:stop'),('触发错误，测试 provider 失败后的界面反馈。','AUDIT_PROVIDER_UNAVAILABLE','done:error'),('恢复后再问一次：2 + 2 等于多少？','\n4\n','done:stop')]
for i,(question,expected,status) in enumerate(questions,1):
 send(question);start=time.monotonic();time.sleep(.8)
 while True:
  frame=capture();passed=expected in frame and status in frame
  if passed or time.monotonic()-start>30:break
  time.sleep(.25)
 (work/f'question-{i}.txt').write_text(frame)
 rows.append({'question':question,'pass':passed,'elapsedSeconds':round(time.monotonic()-start,2),'frame':f'question-{i}.txt'})
 print(json.dumps(rows[-1],ensure_ascii=False),flush=True)
 if not passed:break
(root/'questions-results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
