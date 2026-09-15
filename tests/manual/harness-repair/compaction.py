#!/usr/bin/env python3
"""真实 PATH CLI/TTY 的 compact、工具历史与恢复验证；仅使用本地 HTTP 夹具。"""
from contextlib import closing
from http.server import ThreadingHTTPServer
import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time

from run import Probe, Provider, cleanup


def wire_text(value):
    return value if isinstance(value, str) else "\n".join(part.get("text", "") for part in value if isinstance(part, dict))


class CompactProvider(Provider):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        body = json.loads(raw)
        messages = body.get("messages", [])
        summarizing = bool(messages and "Summarize the supplied historical conversation" in str(messages[0].get("content")))
        last_content = next((item.get("content", "") for item in reversed(messages) if item.get("role") == "user"), "")
        last_user = wire_text(last_content)
        if last_user == "COMPACT_READ_APPROVED" and messages[-1].get("role") == "user":
            self.server.wire_requests.append(body)
            chunk = {"id": "read-approved", "object": "chat.completion.chunk", "model": body["model"], "choices": [{"index": 0,
                     "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_read_approved", "type": "function",
                     "function": {"name": "read", "arguments": json.dumps({"path": "approved.txt"})}}]}, "finish_reason": "tool_calls"}]}
            payload = ("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if summarizing or last_user.startswith("COMPACT_HISTORY_"):
            self.server.wire_requests.append(body)
            summary = ("Goal and constraints: preserve compact verification. "
                       "Decisions and completed work: compact-cli-sentinel. "
                       "Files and tool outcomes: approved.txt was written by governed bash. "
                       "Unresolved tasks: continue verification. Verification evidence: approved tool result. "
                       "Source references: historical source messages.")
            if not summarizing:
                summary = last_user + " Preserve the original audit history." * 180
            chunks = [{"id": "summary", "object": "chat.completion.chunk", "model": body["model"],
                       "choices": [{"index": 0, "delta": {"role": "assistant", "content": summary}, "finish_reason": None}]},
                      {"id": "summary", "object": "chat.completion.chunk", "model": body["model"],
                       "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                       "usage": {"prompt_tokens": 3000, "completion_tokens": 100, "total_tokens": 3100}}]
            payload = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        original = self.rfile
        self.rfile = io.BytesIO(raw)
        try:
            super().do_POST()
        finally:
            self.rfile = original


def records(probe, event_type):
    with closing(sqlite3.connect((probe.root / "home/state.db").as_uri() + "?mode=ro", uri=True)) as conn:
        return [json.loads(row[0]) for row in conn.execute(
            "SELECT payload_json FROM session_events WHERE event_type=? ORDER BY sequence", (event_type,))]


def main():
    root = Path(tempfile.mkdtemp(prefix="runledger-compact-cli-"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), CompactProvider)
    server.requests, server.wire_requests = [], []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    probe = Probe(shutil.which("runledger"), root, server.server_port)
    probe.settings["compaction"] = {"retainRecentTokens": 1000}
    probe.write_settings()
    report = {"passed": False, "root": str(root), "executable": str(probe.executable),
              "provider": "local HTTP fixture; real OpenAI provider remains pending"}
    print(json.dumps(report), flush=True)
    try:
        probe.start()
        before = probe.submit("HARNESS_ALLOW")
        probe.approval()
        probe.tm("send-keys", "-t", "probe:0.0", "y")
        probe.end(before, "stop")
        assert (root / "workspace/approved.txt").read_text() == "approved"
        time.sleep(0.5)
        before = probe.submit("COMPACT_READ_APPROVED")
        probe.end(before, "stop")
        for index in range(4):
            time.sleep(0.5)
            before = probe.submit(f"COMPACT_HISTORY_{index}")
            probe.end(before, "stop")
        time.sleep(0.5)
        raw = records(probe, "ledger.message")
        probe.submit("/compact --strategy=hierarchical preserve tool outcomes")
        committed = probe.wait(lambda: records(probe, "compaction.completed"), "compact", 40)
        assert records(probe, "ledger.message") == raw
        summary_requests = [body for body in server.wire_requests if "Summarize the supplied historical conversation" in str(body.get("messages", [{}])[0].get("content"))]
        assert len(summary_requests) == 1 and not summary_requests[0].get("tools")
        assert "call_allow" in json.dumps(summary_requests[0])
        report["compaction"] = committed[-1]
        probe.save_frame("compact")
        time.sleep(0.5)
        before = probe.submit("AFTER_COMPACT")
        probe.end(before, "stop")
        wire = json.dumps(server.wire_requests[-1])
        assert "compact-cli-sentinel" in wire and "COMPACT_HISTORY_0" not in wire
        assert "COMPACT_HISTORY_3" in wire
        projected_text = "\n".join(wire_text(item.get("content", "")) for item in server.wire_requests[-1].get("messages", []))
        assert '<files>' in projected_text and '(Read) "approved.txt"' in projected_text
        report["first_exit"] = probe.close()
        probe.start(resume=True)
        before = probe.submit("AFTER_RESUME")
        probe.end(before, "stop")
        wire = json.dumps(server.wire_requests[-1])
        assert "compact-cli-sentinel" in wire and "COMPACT_HISTORY_0" not in wire
        probe.save_frame("resumed-turn")
        time.sleep(0.5)
        before = probe.submit("COMPACT_HISTORY_NEW")
        probe.end(before, "stop")
        report["second_exit"] = probe.close()
        session_id = probe.session_ids()[0]
        control_raw = records(probe, "ledger.message")
        for args in (["compact", "list"], ["compact", "run", "--strategy=single-pass"]):
            control = subprocess.run(["runledger", "--session-id", session_id, *args], cwd=root / "workspace", env=probe.env, text=True, capture_output=True, timeout=40)
            assert control.returncode == 0, (control.stdout, control.stderr)
            assert json.loads(control.stdout)["ok"] is True
        assert len(records(probe, "compaction.completed")) == 2
        summary_requests = [body for body in server.wire_requests if "Summarize the supplied historical conversation" in str(body.get("messages", [{}])[0].get("content"))]
        assert "Update the previous summary" in wire_text(summary_requests[-1]["messages"][0]["content"])
        assert "<previous-summary>" in wire_text(summary_requests[-1]["messages"][-1]["content"])
        report["iterative_summary_and_file_list"] = True
        assert records(probe, "ledger.message") == control_raw
        report["standalone_compact_list_and_run"] = True
        report["raw_history_preserved"] = True
        report["passed"] = True
    finally:
        server.shutdown()
        server.server_close()
        report["remaining_owned_pids"] = cleanup(probe)
        (root / "result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report), flush=True)
    assert not report["remaining_owned_pids"]


if __name__ == "__main__":
    main()
