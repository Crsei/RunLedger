#!/usr/bin/env python3
"""真实 CLI/TTY 连续工具调用：检查长历史状态动画是否拖慢进程收尾。"""

import argparse
from contextlib import closing
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import shlex
import shutil
import sqlite3
import statistics
import tempfile
import threading

from run import Probe, Provider, REPO, cleanup


class LatencyProvider(Provider):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path.endswith("/messages"):
            self.reply(404, {"error": "fixture supports chat completions only"})
            return
        messages = body.get("messages", [])
        completed = sum(message.get("role") == "tool" for message in messages)
        self.server.requests.append(completed)
        if completed < self.server.rounds:
            command = f"printf 'LATENCY_{completed:02d}\\n'; cat latency-output.txt"
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_latency_{completed:02d}",
                     "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": command})}}]}
            finish = "tool_calls"
        else:
            delta, finish = {"role": "assistant", "content": "LATENCY_DONE"}, "stop"
        chunks = [{"id": "latency", "object": "chat.completion.chunk", "model": "claude-opus-4-8",
                   "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                  {"id": "latency", "object": "chat.completion.chunk", "model": "claude-opus-4-8",
                   "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                   "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}}]
        payload = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class LatencyProbe(Probe):
    def start(self, width):
        self.tm("new-session", "-d", "-s", "probe", "-x", str(width), "-y", "42",
                "-c", str(self.root / "workspace"), "sleep 3600")
        self.tm("set-window-option", "-t", "probe:0", "remain-on-exit", "on")
        # fixture 只读取隔离文件；仍经真实 Security/ExecutionGateway 和 Session Owner。
        args = [str(self.root / "bin/runledger"), "--permission-profile", "danger-full-access", "--approval-policy", "never"]
        self.tm("respawn-pane", "-k", "-t", "probe:0.0", "exec " + shlex.join(args))
        self.wait(lambda: "Message RunLedger" in self.frame(), "startup", 40)
        self.track_processes()

    def measurements(self):
        with closing(sqlite3.connect((self.root / "home/state.db").as_uri() + "?mode=ro", uri=True)) as conn:
            rows = conn.execute("SELECT event_type,payload_json,created_at_ms FROM session_events ORDER BY sequence").fetchall()
        result = []
        started = terminal = call_id = None
        for kind, payload, timestamp in rows:
            event = json.loads(payload)
            if kind == "agent.event" and event.get("type") == "tool_execution_start":
                started, call_id, terminal = timestamp, event["toolCallId"], None
            elif kind == "process.execution_terminal":
                assert event["event"]["terminal"]["exitCode"] == 0, event
                terminal = timestamp
            elif kind == "agent.event" and event.get("type") == "tool_execution_end":
                assert event["toolCallId"] == call_id and started is not None and terminal is not None, event
                assert not event.get("isError"), event
                result.append({"tool_call_id": call_id, "tool_ms": timestamp - started, "terminal_to_result_ms": timestamp - terminal})
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", default=shutil.which("runledger"))
    parser.add_argument("--width", type=int, choices=[80, 143], default=143)
    args = parser.parse_args()
    if args.executable is None:
        parser.error("runledger is missing from PATH")
    root = Path(tempfile.mkdtemp(prefix="runledger-harness-latency-"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), LatencyProvider)
    server.requests, server.rounds = [], 32
    threading.Thread(target=server.serve_forever, daemon=True).start()
    probe = LatencyProbe(args.executable, root, server.server_port)
    probe.settings["recording"] = {"mode": "events"}
    probe.write_settings()
    (root / "workspace/latency-output.txt").write_text(
        "\n".join(f"line-{index:03d}: " + "中文 output 👩‍💻 " * 7 for index in range(60)), encoding="utf-8")
    report = {"passed": False, "root": str(root), "executable": str(probe.executable), "width": args.width,
              "model": "local deterministic HTTP fixture; no external model requests", "rounds": server.rounds}
    print(json.dumps(report), flush=True)
    try:
        report["dist_files_sha256"] = {
            str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((REPO / "dist/tui").rglob("*.js"))}
        probe.start(args.width)
        before = probe.submit("Run the local latency fixture and report LATENCY_DONE.")
        report["run"] = probe.end(before, "stop", 180)
        report["calls"] = probe.measurements()
        assert len(report["calls"]) == server.rounds, report["calls"]
        assert server.requests == list(range(server.rounds + 1)), server.requests
        gaps = [call["terminal_to_result_ms"] for call in report["calls"]]
        report["early_median_ms"] = statistics.median(gaps[:5])
        report["late_median_ms"] = statistics.median(gaps[-5:])
        report["max_ms"] = max(gaps)
        assert report["late_median_ms"] < 1500, report["late_median_ms"]
        assert report["late_median_ms"] < report["early_median_ms"] + 1000, report
        assert report["max_ms"] < 5000, report["max_ms"]
        probe.wait(lambda: "LATENCY_DONE" in probe.frame(), "final-output")
        probe.save_frame("completed")
        report["exit_code"] = probe.close()
        report["passed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {str(error)[:500]}"
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
        (root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({key: value for key, value in report.items() if key not in {"dist_files_sha256", "calls"}}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
