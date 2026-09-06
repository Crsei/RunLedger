import pathlib,json,shlex
base=pathlib.Path('/tmp/runledger-command-repair-20260905/cli-live')
rs=json.loads((base/'results.json').read_text());s=json.loads((base/'summary.json').read_text());meta=json.loads((base/'metadata.json').read_text())
lines=['# Built PATH CLI repair verification','',f"Executable: `{meta['executable']}` → `{meta['real_executable']}`.",f"Current HEAD: `{meta['repository_head']}`; tested current built dirty working tree.",f"dist/cli/main.js SHA-256: `{meta['dist_main_sha256']}`.",'',f"Result: **{s['passed']}/{s['cases']} passed**, timeouts={s['timeouts']}.",'',meta['provider_credentials'],'All HOME, XDG and RUNLEDGER state is isolated under this evidence directory. No production source edits, staging, commits or process services created by this verification.','',
'Coverage includes canonical security/reload dispatch; user-scoped skill provider mutation persisted to settings; rejected workspace scope preserves user settings; failure exit codes; documented and explicit remember syntax; local gateway token checks; and actual isolated archive migration/deletion with both manifest spellings.','',
'Capability gaps remain explicit failure outcomes. The matrix counts expected rejection with the required nonzero exit code as a successful negative test, not an implemented feature. No real external model completion or provider-credential acceptance is claimed.','',
'| Case | Arguments | Exit | Verdict |','| --- | --- | ---: | --- |']
for r in rs:lines.append('| '+r['id']+' | `'+shlex.join(r['argv'][1:]).replace('|','\\|')+'` | '+str(r['exit_code'])+' | '+('PASS' if r['pass'] else 'FAIL')+' |')
lines.extend(['','Raw complete stdout/stderr is retained in results.json and individual per-command files. Field-level checks, expected outcomes and exact isolated RUNLEDGER_DIR are included in results.json.'])
(base/'report.md').write_text('\n'.join(lines)+'\n')
print(base/'report.md')
