#!/usr/bin/env python3
"""隔离 SQLite 合成历史 + 构建后的真实 CLI/TMUX 颜色验收。"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent

def color_at(text, marker):
    position = text.find(marker)
    if position < 0:
        raise RuntimeError(f"missing marker: {marker}")
    color = None
    for match in re.finditer(r"\x1b\[([0-9;]*)m", text[:position]):
        codes = [int(n) if n else 0 for n in match.group(1).split(';')]
        i = 0
        while i < len(codes):
            code = codes[i]
            if code in (0, 39):
                color = None
            elif code == 48 and i + 4 < len(codes) and codes[i + 1] == 2:
                i += 4
            elif code == 48 and i + 2 < len(codes) and codes[i + 1] == 5:
                i += 2
            elif code == 38 and i + 4 < len(codes) and codes[i + 1] == 2:
                color = codes[i + 2:i + 5]
                i += 4
            elif code == 38 and i + 2 < len(codes) and codes[i + 1] == 5:
                color = ['indexed', codes[i + 2]]
                i += 2
            i += 1
    return color


def run_case(executable, root, preset, mode, width, override=False):
    root.mkdir(mode=0o700)
    seed = subprocess.run(['bun', str(HERE / 'seed.mjs'), str(root)], check=True, text=True, capture_output=True, timeout=20)
    session = seed.stdout.strip()
    (root / 'user').mkdir()
    manifest = root / 'home/state/model-compatibility/manifest.json'
    manifest.parent.mkdir(parents=True)
    shutil.copyfile(HERE.parent / 'native-mode/model-compatibility.fixture.json', manifest)
    theme = {'preset': preset, 'mode': mode}
    if override:
        theme['colors'] = {'common': {'thinkingText': '#123456'}}
    (root / 'home/settings.json').write_text(json.dumps({'uiTheme': theme, 'autoTitle': False, 'enabledModels': ['openai/gpt-5']}))
    env = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(root / 'user'), 'RUNLEDGER_DIR': str(root / 'home'), 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'OPENAI_API_KEY': 'synthetic-ui-fixture-only'}
    socket = 'rl-theme-' + uuid.uuid4().hex
    def tm(*args):
        return subprocess.run(['tmux', '-L', socket, '-f', '/dev/null', *args], env=env, check=True, text=True, capture_output=True, timeout=10).stdout
    def state():
        return tm('display-message', '-p', '-t', 'probe:0.0', '#{pane_dead}|#{pane_dead_status}').strip().split('|')
    def wait_frame(markers, name, expected_color=None):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            frame = tm('capture-pane', '-p', '-e', '-t', 'probe:0.0')
            (root / (name + '.ansi')).write_text(frame)
            if state()[0] == '1':
                raise RuntimeError('TUI exited early')
            if all(marker in frame for marker in markers):
                if expected_color is None or color_at(frame, 'UI_THEME_THOUGHT') == expected_color:
                    return frame
            time.sleep(.1)
        raise RuntimeError(f'timeout waiting for {markers}')
    result = {'preset': preset, 'mode': mode, 'width': width, 'override': override, 'passed': False, 'executable': str(Path(executable).resolve())}
    try:
        tm('new-session', '-d', '-s', 'probe', '-x', str(width), '-y', '32', '-c', str(root / 'workspace'), 'sleep 3600')
        tm('set-window-option', '-t', 'probe:0', 'remain-on-exit', 'on')
        command = [executable, '--session-id', session, '--provider', 'openai', '--model', 'gpt-5']
        tm('respawn-pane', '-k', '-t', 'probe:0.0', 'exec ' + shlex.join(command))
        frame = wait_frame(['UI_THEME_THOUGHT', 'UI_THEME_ANSWER', 'Message RunLedger'], 'main')
        palette = {'default': {'dark': [119,125,136], 'light': [108,108,108]}, 'neutral': {'dark': [144,144,144], 'light': [102,102,102]}, 'high-contrast': {'dark': [176,176,176], 'light': [80,80,80]}}
        expected = [18,52,86] if override else palette[preset]['dark' if mode == 'auto' else mode]
        result['main_thinking'] = color_at(frame, 'UI_THEME_THOUGHT')
        result['main_answer'] = color_at(frame, 'UI_THEME_ANSWER')
        if result['main_thinking'] != expected or result['main_thinking'] == result['main_answer']:
            raise RuntimeError(f'wrong main colors: {result}')
        if mode == 'auto':
            # 模拟终端主题通知及其 OSC 10/11 回复，验证真实输入解析链。
            reply = '\x1b[?997;1n\x1b]10;rgb:0000/0000/0000\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
            tm('send-keys', '-t', 'probe:0.0', '-l', '--', reply)
            expected = palette[preset]['light']
            frame = wait_frame(['UI_THEME_THOUGHT'], 'auto-light', expected)
            result['auto_light_thinking'] = color_at(frame, 'UI_THEME_THOUGHT')
        tm('send-keys', '-t', 'probe:0.0', 'C-t')
        frame = wait_frame(['Read-only transcript', 'UI_THEME_THOUGHT'], 'transcript')
        result['transcript_thinking'] = color_at(frame, 'UI_THEME_THOUGHT')
        if result['transcript_thinking'] != expected:
            raise RuntimeError(f'wrong transcript color: {result}')
        tm('send-keys', '-t', 'probe:0.0', 'Escape')
        time.sleep(.15)
        tm('send-keys', '-t', 'probe:0.0', 'C-d')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and state()[0] != '1':
            time.sleep(.1)
        result['exit'] = state()
        if result['exit'] != ['1', '0']:
            raise RuntimeError('unclean TUI shutdown')
        result['passed'] = True
    except (RuntimeError, subprocess.SubprocessError) as error:
        result['error'] = str(error)
    finally:
        try:
            tm('kill-server')
        except subprocess.SubprocessError:
            pass
        (root / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--executable', default='runledger')
    parser.add_argument('--single', action='store_true')
    parser.add_argument('--auto-only', action='store_true')
    args = parser.parse_args()
    executable = shutil.which(args.executable)
    if executable is None:
        raise RuntimeError('CLI executable not found')
    root = Path(tempfile.mkdtemp(prefix='rl-theme-matrix-'))
    cases = [('default', 'auto', 80, False)] if args.auto_only else [('default', 'dark', 80, False)] if args.single else [(p,m,w,False) for p in ['default','neutral','high-contrast'] for m in ['dark','light'] for w in [80,143]] + [('default','dark',80,True), ('default','auto',80,False)]
    results = []
    for index, (preset, mode, width, override) in enumerate(cases):
        result = run_case(executable, root / str(index), preset, mode, width, override)
        results.append(result)
        if not result['passed']:
            break
    summary = {'root': str(root), 'planned': len(cases), 'results': results, 'passed': len(results) == len(cases) and all(r['passed'] for r in results)}
    (root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))
    return 0 if summary['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
