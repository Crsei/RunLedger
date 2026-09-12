#!/usr/bin/env python3
"""通过标准 RunLedger TTY 执行真实开发案例；只在独立目录创建测试数据。"""

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


def digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return {"algorithm": "sha256", "digest": hashlib.sha256(encoded).hexdigest()}


def summarize_turn(result, cli_exit):
    events = result["events"]
    terminal = next((event for event in reversed(events) if event.get("type") == "agent_end"), {})
    errors = [event.get("message", {}).get("errorMessage") for event in events
              if event.get("type") == "message_end" and event.get("role") == "assistant"
              and event.get("stopReason") == "error"]
    tools = [event for event in events if event.get("type") == "tool_execution_end"]
    return {"status": "failed_model" if errors or terminal.get("stopReason") == "error"
            else "awaiting_independent_verification" if terminal.get("stopReason") == "stop" and cli_exit == 0
            else "incomplete", "cli_exit": cli_exit, "agent_stop_reason": terminal.get("stopReason"),
            "termination_reason": terminal.get("terminationReason"),
            "duration_seconds": result["duration_seconds"], "active_duration_ms": terminal.get("activeDurationMs"),
            "tool_calls_completed": len(tools), "model_errors": errors,
            "tool_failures": sum(bool(event.get("isError")) for event in tools),
            "task_acceptance_passed": False}


def user_model_config():
    source = Path(os.environ.get("RUNLEDGER_DIR", str(Path.home() / ".runledger")))
    if not source.is_absolute() or not source.is_dir():
        raise RuntimeError("User RunLedger home must be an existing absolute directory")
    settings = json.loads((source / "settings.json").read_text())
    provider, model = settings.get("provider"), settings.get("model")
    if provider != "deepseek" or not isinstance(model, str):
        raise RuntimeError("This runner currently supports the configured DeepSeek API-key provider only; no fallback model")
    # 只读解析现有凭据到子进程内存，不使用会创建锁文件的生产 AuthStorage backend。
    auth_path = source / "auth.json"
    stored = json.loads(auth_path.read_text()).get(provider, {}) if auth_path.is_file() else {}
    if stored and stored.get("type") != "api_key":
        raise RuntimeError("Only existing API-key credentials are supported")
    key = stored.get("key", "")
    if key:
        scoped = stored.get("env", {})
        key = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
                     lambda match: scoped.get(match[1], os.environ.get(match[1], "")), key)
    key = key or os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise RuntimeError("Configured DeepSeek credential is unavailable")
    manifest_path = source / "state/model-compatibility/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    return {"provider": provider, "model": model, "thinking": settings.get("thinkingLevel", "off"),
            "key": key, "source": str(source / "settings.json"),
            "manifest": manifest}


class Case:
    def __init__(self, root, case_id, verification=None):
        self.root = root
        self.case_id = case_id
        self.socket = "rl-devcase-" + uuid.uuid4().hex
        self.target = "case:0.0"
        self.config = user_model_config()
        self.profile_source = "read-only snapshot of user-home manifest"
        if verification is not None:
            artifact = json.loads(Path(verification).read_text())
            proof = artifact["verification"]
            if (proof.get("passed") is not True or proof.get("provider") != self.config["provider"]
                    or proof.get("model") != self.config["model"] or proof.get("thinking") != self.config["thinking"]):
                raise RuntimeError("Live verification does not match configured model/thinking")
            profiles = artifact["manifest"]["profiles"]
            if len(profiles) != 1 or profiles[0]["manifestDigest"] != digest(proof):
                raise RuntimeError("Live profile evidence digest mismatch")
            self.config["manifest"] = artifact["manifest"]
            self.profile_source = "isolated live verification: " + str(verification)
        self.env = {key: os.environ[key] for key in (
            "PATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
            "http_proxy", "https_proxy", "all_proxy", "no_proxy") if key in os.environ}
        self.env.update(HOME=str(root / "user"), RUNLEDGER_DIR=str(root / "home"),
                        TERM="xterm-256color", LANG="C.UTF-8",
                        DEEPSEEK_API_KEY=self.config.pop("key"))

    def tm(self, *args, input=None):
        return subprocess.run(["tmux", "-L", self.socket, "-f", "/dev/null", *args],
                              input=input, text=True, capture_output=True,
                              check=True, timeout=10, env=self.env).stdout

    def prepare(self):
        for name in ("home", "user", "workspace"):
            (self.root / name).mkdir()
        if self.case_id in ("01-jsonl", "02-tasks", "06-csv"):
            binary = shutil.which("bun")
            if binary is None:
                raise RuntimeError("Bun is required for TypeScript case fixtures")
            (self.root / "workspace/.runtime").mkdir()
            shutil.copy2(Path(binary).resolve(), self.root / "workspace/.runtime/bun")
        manifest = self.root / "home/state/model-compatibility/manifest.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps(self.config["manifest"]))
        (self.root / "home/settings.json").write_text(json.dumps({
            "theme": "dark", "autoTitle": False, "agentMode": "default",
            "provider": self.config["provider"], "model": self.config["model"],
            "thinkingLevel": self.config["thinking"],
            }))
        runtime_hint = ("可使用当前目录下的 ./.runtime/bun 执行 TypeScript，无需联网安装依赖。"
                        if (self.root / "workspace/.runtime/bun").is_file()
                        else "使用已安装的 Python 标准库，无需联网安装依赖。")
        (self.root / "workspace/AGENTS.md").write_text(
            "只在当前练习目录实现本次任务。不要 git commit 或 push，不读取凭据或环境变量。"
            + runtime_hint +
            "测试结果必须来自实际执行，不能把预期输出当实测。\n", encoding="utf-8")
        (self.root / "identity.json").write_text(json.dumps({
            "socket": self.socket, "case": self.case_id, "configured_model": self.config["model"],
            "provider": self.config["provider"], "thinking": self.config["thinking"], "mode": "default",
            "settings_source": self.config["source"],
            "profile_source": self.profile_source}, indent=2))

    def launch(self, resume=False):
        # 不用 CLI model/provider 覆盖用户 settings；启动后再次核对实际选择。
        binary = shutil.which("runledger", path=self.env["PATH"])
        if binary is None or Path(binary).resolve() != REPO / "bin/runledger.js":
            raise RuntimeError("PATH runledger must resolve to this checkout")
        artifact = REPO / "dist/cli/cli.js"
        (self.root / "executable.json").write_text(json.dumps({
            "executable": binary, "resolved_executable": str(Path(binary).resolve()),
            "dist_entry_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
        }, indent=2))
        permission = "read-only" if self.case_id == "04-trace" else "workspace-write"
        command = ["runledger", "--permission-profile", permission, "--approval-policy",
                   "never" if self.case_id == "04-trace" else "on-request"]
        command += ["--continue"] if resume else ["--mode", "default"]
        self.tm("new-session", "-d", "-s", "case", "-x", "143", "-y", "42",
                "-c", str(REPO if self.case_id == "04-trace" else self.root / "workspace"), "sleep 3600")
        self.tm("set-window-option", "-t", "case:0", "remain-on-exit", "on")
        self.tm("respawn-pane", "-k", "-t", self.target, "exec " + shlex.join(command))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            frame = self.capture("startup")
            if self.state()[0] == "1":
                raise RuntimeError("RunLedger exited before ready")
            if "Message RunLedger" in frame:
                time.sleep(0.3)
                frame = self.capture("startup")
                matches = re.findall(re.escape(self.config["provider"]) + r"/([A-Za-z0-9._:-]+)", frame)
                observed = sorted(set(matches))
                (self.root / "model-selection.json").write_text(json.dumps({
                    "configured_model": self.config["model"], "observed_models": observed,
                    "prompt_submitted": False}, indent=2))
                if observed != [self.config["model"]]:
                    raise RuntimeError("Configured/active model mismatch: " + repr(observed))
                return
            time.sleep(0.2)
        raise RuntimeError("RunLedger readiness timeout")

    def state(self):
        return self.tm("display-message", "-p", "-t", self.target,
                       "#{pane_dead}|#{pane_dead_status}").strip().split("|")

    def capture(self, name):
        text = self.tm("capture-pane", "-p", "-S", "-2000", "-t", self.target)
        (self.root / (name + ".txt")).write_text(text, encoding="utf-8")
        return text

    def events(self):
        with closing(sqlite3.connect((self.root / "home/state.db").as_uri() + "?mode=ro", uri=True)) as conn:
            return [(row[0], json.loads(row[1])) for row in conn.execute(
                "SELECT sequence, payload_json FROM session_events WHERE event_type='agent.event' ORDER BY sequence")]

    def submit(self, prompt, label):
        (self.root / (label + "-prompt.txt")).write_text(prompt, encoding="utf-8")
        previous = max((seq for seq, _ in self.events()), default=0)
        self.tm("load-buffer", "-", input=prompt)
        self.tm("paste-buffer", "-p", "-d", "-t", self.target)
        time.sleep(0.3)
        self.tm("send-keys", "-t", self.target, "Enter")
        selection_path = self.root / "model-selection.json"
        selection = json.loads(selection_path.read_text())
        selection["prompt_submitted"] = True
        selection_path.write_text(json.dumps(selection, indent=2))
        return previous

    def wait_turn(self, previous, label, timeout=600):
        started = time.monotonic()
        while time.monotonic() - started < timeout:
            events = [event for seq, event in self.events() if seq > previous]
            (self.root / "progress.json").write_text(json.dumps({
                "label": label, "elapsed_seconds": round(time.monotonic() - started, 1),
                "event_count": len(events),
                "tool_calls_completed": sum(event.get("type") == "tool_execution_end" for event in events),
                "last_type": events[-1].get("type") if events else None}))
            self.capture(label + "-frame")
            if any(event.get("type") == "agent_end" for event in events):
                result = {"duration_seconds": round(time.monotonic() - started, 3), "events": events}
                (self.root / (label + "-events.json")).write_text(
                    json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                return result
            if self.state()[0] == "1":
                raise RuntimeError("RunLedger exited while waiting for model")
            time.sleep(0.5)
        raise RuntimeError("Development turn timed out")

    def close(self):
        if self.state()[0] != "1":
            self.tm("send-keys", "-t", self.target, "Escape")
            time.sleep(0.2)
            self.tm("send-keys", "-t", self.target, "C-d")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            dead, code = self.state()
            if dead == "1":
                self.tm("kill-server")
                return int(code)
            time.sleep(0.2)
        raise RuntimeError("RunLedger did not exit cleanly")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", choices=("01-jsonl", "02-tasks", "03-rename", "05-markdown", "06-csv"))
    parser.add_argument("--verification", type=Path)
    args = parser.parse_args()
    prompts = json.loads(Path(__file__).with_name("prompts.json").read_text())
    root = Path(tempfile.mkdtemp(prefix="runledger-dev-" + args.case + "-"))
    print("Artifacts:", root, flush=True)
    case = Case(root, args.case, args.verification)
    case.prepare()
    try:
        case.launch()
        previous = case.submit(prompts[args.case][0], "round-1")
        result = case.wait_turn(previous, "round-1")
        for event in result["events"]:
            if event.get("type") in ("agent_end", "message_end", "tool_execution_end"):
                print(json.dumps(event, ensure_ascii=False), flush=True)
        summary = summarize_turn(result, case.close())
        (root / "outcome.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        return 0 if summary["status"] == "awaiting_independent_verification" else 1
    except Exception as error:
        print(type(error).__name__, str(error), flush=True)
        try:
            case.capture("failure")
            case.close()
        except Exception:
            case.tm("kill-server")
        return 1
if __name__ == "__main__":
    sys.exit(main())
