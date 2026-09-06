#!/usr/bin/env python3
"""隔离的真实 tmux/TUI 模式入口 smoke；仅使用 Python 标准库。"""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid


REPO = Path(__file__).resolve().parents[3]


def database_evidence(path, *, allow_empty=False):
    # mode=ro 在路径错误时失败，不创建空数据库，也不修改 authority。
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as conn:
        rows = conn.execute("SELECT session_id, status FROM sessions").fetchall()
    if not rows and not allow_empty:
        raise RuntimeError("SQLite has no persisted session")
    return [{"session_id": row[0], "status": row[1]} for row in rows]


class Probe:
    def __init__(self, args, root):
        self.args = args
        self.root = root
        self.socket = "rl-mode-" + uuid.uuid4().hex
        self.env = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(root / "user"),
            "LANG": "C.UTF-8",
            "TERM": "xterm-256color",
            "RUNLEDGER_DIR": str(root / "home"),
            "OPENAI_API_KEY": "runledger-mode-test-placeholder",
        }

    def tm(self, *args):
        return subprocess.run(
            ["tmux", "-L", self.socket, "-f", "/dev/null", *args],
            env=self.env, text=True, capture_output=True, check=True, timeout=10,
        ).stdout

    def state(self):
        return self.tm("display-message", "-p", "-t", "probe:0.0",
                       "#{pane_dead}|#{pane_dead_status}").strip().split("|")

    def frame(self, name):
        value = self.tm("capture-pane", "-p", "-t", "probe:0.0")
        (self.root / (name + ".txt")).write_text(value, encoding="utf-8")
        history = self.tm("capture-pane", "-p", "-S", "-2000", "-t", "probe:0.0")
        (self.root / "history.txt").write_text(history, encoding="utf-8")
        return value

    def wait_frame(self, name, markers):
        deadline = time.monotonic() + self.args.timeout
        stable_since = None
        while time.monotonic() < deadline:
            frame = self.frame(name)
            dead, code = self.state()
            if dead == "1":
                raise RuntimeError(f"TUI exited during {name}: {code}")
            if re.search(r"\[runledger\]\s*fatal:|(?:Syntax|Reference|Type)Error:", frame):
                raise RuntimeError(f"TUI fatal error during {name}")
            if all(marker in frame for marker in markers):
                stable_since = stable_since or time.monotonic()
                if time.monotonic() - stable_since >= 0.3:
                    return
            else:
                stable_since = None
            time.sleep(0.1)
        raise RuntimeError(f"Timed out during {name}; expected {markers!r}")

    def stop(self):
        # 分开发送 Escape 和 Ctrl+D，等待弹窗关闭后再退出。
        if self.state()[0] != "1":
            for _ in range(2):
                self.tm("send-keys", "-t", "probe:0.0", "Escape")
                time.sleep(0.15)
            self.tm("send-keys", "-t", "probe:0.0", "C-d")
        deadline = time.monotonic() + self.args.timeout
        while time.monotonic() < deadline:
            dead, code = self.state()
            if dead == "1":
                if code != "0":
                    raise RuntimeError(f"Unclean TUI exit: {code}")
                return 0
            time.sleep(0.1)
        raise RuntimeError("TUI did not exit after Escape / Ctrl+D")

    def run(self):
        evidence = {"passed": False, "mode": self.args.mode,
                    "dimensions": [self.args.width, self.args.height],
                    "socket": self.socket, "artifact_dir": str(self.root)}
        # 即使驱动器被强制终止，也保留本次资源身份；初始状态绝不表示通过。
        (self.root / "result.json").write_text(
            json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        launched = False
        stopped = False
        try:
            binary = shutil.which(self.args.executable)
            if not binary:
                raise RuntimeError(f"Executable not found: {self.args.executable}")
            resolved = Path(binary).resolve()
            if self.args.executable == "runledger" and resolved != REPO / "bin/runledger.js":
                raise RuntimeError(f"PATH runledger targets another checkout: {resolved}")
            evidence.update(executable=binary, resolved_executable=str(resolved))
            artifact = REPO / "dist/cli/cli.js"
            if resolved == REPO / "bin/runledger.js" and artifact.exists():
                evidence["dist_entry_sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
            for directory in ("home", "user", "workspace"):
                (self.root / directory).mkdir()
            manifest = self.root / "home/state/model-compatibility/manifest.json"
            manifest.parent.mkdir(parents=True)
            fixture = Path(__file__).with_name("model-compatibility.fixture.json")
            shutil.copyfile(fixture, manifest)
            evidence["model_profile_source"] = "synthetic UI fixture; not provider verification"
            (self.root / "home/settings.json").write_text(json.dumps({
                "theme": self.args.theme, "autoTitle": False,
                "agentMode": self.args.mode, "enabledModels": ["openai/gpt-5"],
            }), encoding="utf-8")
            command = [binary, "--mode", self.args.mode, "--provider", "openai",
                       "--model", "gpt-5", "--thinking", "low"]
            evidence["argv"] = command
            self.tm("new-session", "-d", "-s", "probe", "-x", str(self.args.width),
                    "-y", str(self.args.height), "-c", str(self.root / "workspace"), "sleep 3600")
            launched = True
            self.tm("set-window-option", "-t", "probe:0", "remain-on-exit", "on")
            self.tm("respawn-pane", "-k", "-t", "probe:0.0", "exec " + shlex.join(command))
            self.wait_frame("startup", ["Message RunLedger", "Mode: " + self.args.mode])
            self.tm("send-keys", "-t", "probe:0.0", "-l", "--", "/mode")
            self.tm("send-keys", "-t", "probe:0.0", "Enter")
            self.wait_frame("mode-picker", ["Select agent mode", "Current: " + self.args.mode])
            # 正常退出会回收无用户消息的会话，因此落库断言必须在退出前取证。
            evidence["sessions_before_exit"] = database_evidence(self.root / "home/state.db")
            evidence["exit_code"] = self.stop()
            stopped = True
            self.frame("exit")
            evidence["sessions_after_exit"] = database_evidence(
                self.root / "home/state.db", allow_empty=True)
            evidence["passed"] = True
        except (OSError, RuntimeError, sqlite3.Error, subprocess.SubprocessError, KeyboardInterrupt) as error:
            evidence["error"] = str(error) or type(error).__name__
        finally:
            if launched:
                if not stopped:
                    try:
                        self.frame("failure")
                        self.stop()
                    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                        evidence["shutdown_error"] = str(error)
                try:
                    # socket 为每次运行独占，绝不操作默认 tmux server。
                    self.tm("kill-server")
                except (OSError, subprocess.SubprocessError) as error:
                    evidence["cleanup_error"] = str(error)
                    evidence["passed"] = False
            (self.root / "result.json").write_text(
                json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("default", "minimal", "plan"), default="default")
    parser.add_argument("--theme", choices=("dark", "light"), default="dark")
    parser.add_argument("--width", type=int, default=143)
    parser.add_argument("--height", type=int, default=42)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--executable", default="runledger",
                        help="默认验证 PATH 指向本 checkout；覆盖值用于候选入口或驱动器负向测试")
    parser.add_argument("--output-parent", type=Path, default=Path(tempfile.gettempdir()))
    args = parser.parse_args()
    if args.width < 40 or args.height < 20 or not 0 < args.timeout <= 120:
        parser.error("width >= 40, height >= 20, 0 < timeout <= 120 required")
    if not shutil.which("tmux"):
        parser.error("tmux is required")
    root = Path(tempfile.mkdtemp(prefix="runledger-mode-native-", dir=args.output_parent)).resolve()
    print(f"Artifacts: {root}", flush=True)
    result = Probe(args, root).run()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
