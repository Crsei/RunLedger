#!/usr/bin/env python3
"""构建后真实 CLI/TTY 的审批、中断、恢复回归；模型使用本地确定性 HTTP fixture。"""

import argparse
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid


REPO = Path(__file__).resolve().parents[3]
COMMANDS = {
    "ALLOW": "printf approved > approved.txt",
    "CANCEL": "printf forbidden > forbidden.txt",
    "EXPIRE": "printf expired > expired.txt",
    "RUNNING": "printf started > started.txt; sleep 30; printf late > late.txt",
    "RECOVER": "printf recovered-too-early > recovery-forbidden.txt",
}


def digest(value):
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {"algorithm": "sha256", "digest": hashlib.sha256(data.encode()).hexdigest()}


def process_identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except (OSError, IndexError):
        return None


def owned_descendants(pid):
    result = {}
    identity = process_identity(pid)
    if identity is None:
        return result
    result[pid] = identity
    try:
        children = Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
    except OSError:
        children = []
    for child in children:
        result.update(owned_descendants(int(child)))
    return result


def cleanup(probe):
    owned = dict(probe.owned)
    try:
        pid = int(probe.tm("display-message", "-p", "-t", "probe:0.0", "#{pane_pid}").strip())
        if probe.exit_status() is None:
            owned.update(owned_descendants(pid))
    except (ValueError, subprocess.SubprocessError):
        pass
    for signum in (signal.SIGTERM, signal.SIGKILL):
        for pid, identity in reversed(list(owned.items())):
            if process_identity(pid) == identity:
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and any(process_identity(pid) == identity for pid, identity in owned.items()):
            time.sleep(0.05)
    subprocess.run(["tmux", "-L", probe.socket, "kill-server"], capture_output=True, timeout=10)
    return [pid for pid, identity in owned.items() if process_identity(pid) == identity]


class Provider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200, {"data": [{"id": name, "context_window": 131072, "max_tokens": 4096}
                                 for name in ("fixture", "alternate")]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path.endswith("/messages"):
            self.reply(404, {"error": "fixture supports chat completions only"})
            return
        if not body.get("stream"):
            self.reply(200, {"id": "probe", "object": "chat.completion", "model": "claude-opus-4-8",
                             "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                             "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
            return
        messages = body.get("messages", [])
        index = max((i for i, item in enumerate(messages) if item.get("role") == "user"), default=-1)
        prompt = str(messages[index].get("content", "")) if index >= 0 else ""
        marker = next((name for name in COMMANDS if "HARNESS_" + name in prompt), "AFTER")
        has_result = any(item.get("role") == "tool" for item in messages[index + 1:])
        self.server.requests.append({"marker": marker, "has_tool_result": has_result})
        if marker in COMMANDS and not has_result:
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_" + marker.lower(),
                     "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": COMMANDS[marker]})}}]}
            finish = "tool_calls"
        else:
            delta, finish = {"role": "assistant", "content": marker + "_DONE"}, "stop"
        chunks = [{"id": "completion", "object": "chat.completion.chunk", "model": "claude-opus-4-8",
                   "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                  {"id": "completion", "object": "chat.completion.chunk", "model": "claude-opus-4-8",
                   "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                   "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}}]
        payload = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class Probe:
    def __init__(self, executable, root, port):
        self.root, self.executable = root, Path(executable).resolve()
        self.owned = {}
        self.socket = "rl-harness-" + uuid.uuid4().hex
        for directory in ("home", "user", "workspace", "bin"):
            (root / directory).mkdir()
        (root / "bin/runledger").symlink_to(self.executable)
        self.env = {"PATH": str(root / "bin") + os.pathsep + os.environ.get("PATH", os.defpath),
                    "HOME": str(root / "user"), "RUNLEDGER_DIR": str(root / "home"),
                    "TERM": "xterm-256color", "LANG": "C.UTF-8", "LITELLM_BASE_URL": f"http://127.0.0.1:{port}/v1", "NO_PROXY": "127.0.0.1,localhost"}
        self.settings = {"provider": "litellm", "model": "claude-opus-4-8", "thinkingLevel": "off",
                         "autoTitle": False, "idleRecap": {"enabled": False}, "recording": {"mode": "off"}}
        self.write_settings()
        self.install_manifest("claude-opus-4-8")

    def write_settings(self):
        (self.root / "home/settings.json").write_text(json.dumps(self.settings))

    def install_manifest(self, model):
        profile = {"profileId": "litellm/" + model, "providerId": "litellm", "modelId": model,
                   "manifestVersion": "synthetic-harness-fixture", "manifestDigest": digest("synthetic fixture"),
                   "contextWindow": 200000, "maxOutputTokens": 32768, "reasoningProtocol": "native",
                   "toolProtocol": "json", "imageInput": False, "compaction": "none", "status": "verified"}
        body = {"version": 1, "profiles": [profile], "aliases": {}}
        path = self.root / "home/state/model-compatibility/manifest.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({**body, "manifestDigest": digest(body)}))

    def tm(self, *args):
        return subprocess.run(["tmux", "-L", self.socket, "-f", "/dev/null", *args], env=self.env,
                              text=True, capture_output=True, check=True, timeout=10).stdout

    def track_processes(self):
        pid = int(self.tm("display-message", "-p", "-t", "probe:0.0", "#{pane_pid}").strip())
        self.owned.update(owned_descendants(pid))

    def frame(self):
        return self.tm("capture-pane", "-p", "-S", "-1000", "-t", "probe:0.0")

    def save_frame(self, name):
        value = self.frame()
        (self.root / (name + ".txt")).write_text(value)
        return value

    def wait(self, check, label, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = check()
            if value:
                return value
            time.sleep(0.1)
        self.save_frame("failure-" + label)
        raise RuntimeError("Timed out: " + label)

    def start(self, resume=False):
        if not resume:
            self.tm("new-session", "-d", "-s", "probe", "-x", "143", "-y", "42",
                    "-c", str(self.root / "workspace"), "sleep 3600")
            self.tm("set-window-option", "-t", "probe:0", "remain-on-exit", "on")
        args = [str(self.root / "bin/runledger"), "--permission-profile", "workspace-write", "--approval-policy", "on-request"]
        if resume:
            args.append("--continue")
        self.tm("respawn-pane", "-k", "-t", "probe:0.0", "exec " + shlex.join(args))
        self.wait(lambda: "Message RunLedger" in self.frame(), "startup", 40)
        self.track_processes()
        self.save_frame("resumed" if resume else "startup")

    def events(self):
        path = self.root / "home/state.db"
        if not path.exists():
            return []
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as conn:
            return [json.loads(row[0]) for row in conn.execute(
                "SELECT payload_json FROM session_events WHERE event_type='agent.event' ORDER BY sequence")]

    def session_ids(self):
        with closing(sqlite3.connect((self.root / "home/state.db").as_uri() + "?mode=ro", uri=True)) as conn:
            return [row[0] for row in conn.execute("SELECT session_id FROM sessions ORDER BY session_id")]

    def submit(self, text):
        before = sum(event.get("type") == "agent_end" for event in self.events())
        self.tm("send-keys", "-t", "probe:0.0", "-l", "--", text)
        self.tm("send-keys", "-t", "probe:0.0", "Enter")
        return before

    def approval(self):
        self.wait(lambda: "Yes, proceed" in self.tm("capture-pane", "-p", "-t", "probe:0.0"), "approval")

    def end(self, before, reason, timeout=20):
        def completed():
            ends = [event for event in self.events() if event.get("type") == "agent_end"]
            return ends[-1] if len(ends) > before else None
        event = self.wait(completed, "agent-end", timeout)
        assert event["stopReason"] == reason, event
        return event

    def exit_status(self):
        fields = self.tm("display-message", "-p", "-t", "probe:0.0", "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}").strip().split("|")
        if fields[0] != "1":
            return None
        if fields[1]:
            return fields[1]
        return "signal:" + fields[2]

    def close(self):
        if self.exit_status() is None:
            for _ in range(2):
                self.tm("send-keys", "-t", "probe:0.0", "Escape")
                time.sleep(0.15)
            self.tm("send-keys", "-t", "probe:0.0", "C-d")
        code = self.wait(lambda: self.exit_status(), "exit")
        assert code == "0", code
        return int(code)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", default=str(REPO / "bin/runledger.js"))
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="runledger-harness-repair-"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    server.requests = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    probe = Probe(args.executable, root, server.server_port)
    report = {"passed": False, "root": str(root), "executable": str(probe.executable),
              "model": "local deterministic HTTP fixture through LiteLLM adapter; not a Claude or real-provider run", "checks": {}}
    print(json.dumps(report), flush=True)
    try:
        probe.start()
        report["dist_files_sha256"] = {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
                                       for path in sorted((REPO / "dist").rglob("*")) if path.is_file()}
        before = probe.submit("HARNESS_ALLOW")
        probe.approval()
        probe.tm("send-keys", "-t", "probe:0.0", "y")
        report["checks"]["allow"] = probe.end(before, "stop")
        assert (root / "workspace/approved.txt").read_text() == "approved"
        probe.save_frame("allow")
        before = probe.submit("HARNESS_CANCEL")
        probe.approval()
        probe.tm("send-keys", "-t", "probe:0.0", "C-c")
        report["checks"]["cancel"] = probe.end(before, "aborted", 5)
        assert not (root / "workspace/forbidden.txt").exists()
        probe.save_frame("cancel")
        before = probe.submit("HARNESS_RUNNING")
        probe.approval()
        probe.tm("send-keys", "-t", "probe:0.0", "Enter")
        probe.wait(lambda: (root / "workspace/started.txt").exists(), "running-start")
        probe.track_processes()
        probe.tm("send-keys", "-t", "probe:0.0", "C-c")
        report["checks"]["running_cancel"] = probe.end(before, "aborted", 10)
        assert not (root / "workspace/late.txt").exists()
        probe.save_frame("running-cancel")
        before = probe.submit("HARNESS_EXPIRE")
        probe.approval()
        report["checks"]["expiry"] = probe.end(before, "stop", 40)
        expired = [event for event in probe.events() if event.get("type") == "tool_execution_end"
                   and event.get("result", {}).get("details", {}).get("errorCode") == "approval_expired"]
        assert expired, "expiry was not reported with its actual error code"
        assert not (root / "workspace/expired.txt").exists()
        probe.save_frame("expiry")
        before = probe.submit("HARNESS_RECOVER")
        probe.approval()
        sessions = probe.session_ids()
        # 仅终止本测试 pane 的 Bun 子进程；此时仍在审批，尚未启动工具进程。
        pane_pid = int(probe.tm("display-message", "-p", "-t", "probe:0.0", "#{pane_pid}").strip())
        children = Path(f"/proc/{pane_pid}/task/{pane_pid}/children").read_text().split()
        candidates = [int(pid) for pid in [str(pane_pid), *children]
                      if "dist/cli/cli.js" in Path(f"/proc/{pid}/cmdline").read_bytes().decode().replace("\x00", " ")]
        assert len(candidates) == 1, "could not identify the isolated CLI process"
        os.kill(candidates[0], signal.SIGKILL)
        probe.wait(lambda: probe.exit_status(), "forced-exit")
        # Owner 心跳 stale 门禁为 20 秒；不能将本地 PID 消失当作接管授权。
        with closing(sqlite3.connect((root / "home/state.db").as_uri() + "?mode=ro", uri=True)) as conn:
            heartbeat = conn.execute("SELECT MAX(heartbeat_at_ms) FROM session_owners").fetchone()[0]
        probe.wait(lambda: time.time() * 1000 > heartbeat + 20_000, "owner-heartbeat-stale", 25)
        probe.start(resume=True)
        assert probe.session_ids() == sessions
        assert "Outcome unknown" in probe.save_frame("recovery-before-assess")
        probe.submit("/recovery assess")
        probe.wait(lambda: "state=ready" in probe.frame(), "recovery-assess")
        current = probe.tm("capture-pane", "-p", "-t", "probe:0.0")
        assert "Mode: default · Recovery required" not in current
        before = probe.submit("HARNESS_AFTER")
        report["checks"]["resume"] = probe.end(before, "stop")
        assert not (root / "workspace/recovery-forbidden.txt").exists()
        probe.save_frame("recovery-after")
        report["exit_code"] = probe.close()
        for name in ("forbidden.txt", "late.txt", "expired.txt", "recovery-forbidden.txt"):
            assert not (root / "workspace" / name).exists(), "late side effect: " + name
        (root / "events.json").write_text(json.dumps(probe.events(), ensure_ascii=False, indent=2))
        # 已配置模型未准入时必须显式失败，不能调用另一个可用模型。
        probe.install_manifest("alternate")
        count = len(server.requests)
        probe.tm("respawn-pane", "-k", "-t", "probe:0.0", "exec " + shlex.join([str(root / "bin/runledger"), "--continue"]))
        mismatch_exit = probe.wait(lambda: probe.exit_status(), "model-mismatch", 40)
        mismatch_frame = probe.save_frame("model-mismatch")
        assert mismatch_exit != "0" and "model profile is not verified" in mismatch_frame
        assert len(server.requests) == count, "model substitution emitted a request"
        report["checks"]["model_mismatch"] = {"exit_code": int(mismatch_exit), "model_requests": 0}
        report["passed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        try:
            probe.save_frame("failure")
        except Exception:
            pass
    finally:
        report["remaining_owned_pids"] = cleanup(probe)
        if report["remaining_owned_pids"]:
            report["passed"] = False
        server.shutdown()
        server.server_close()
        report["http_requests"] = server.requests
        (root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({key: value for key, value in report.items() if key != "dist_files_sha256"}, ensure_ascii=False, indent=2), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
