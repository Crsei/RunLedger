#!/usr/bin/env python3
"""同一真实 TUI 会话的权限即时生效；复用本地 provider 与进程清理夹具。"""
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import sqlite3
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("harness_fixture", REPO / "tests/manual/harness-repair/run.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def main():
    root = Path(tempfile.mkdtemp(prefix="runledger-active-permissions-", dir=REPO.parent))
    server = harness.ThreadingHTTPServer(("127.0.0.1", 0), harness.Provider)
    server.requests, server.wire_requests = [], []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    executable = shutil.which("runledger")
    assert Path(executable).resolve() == REPO / "bin/runledger.js"
    probe = harness.Probe(executable, root, server.server_port)
    probe.settings["security"] = {"profile": "workspace-write"}
    probe.write_settings()
    harness.COMMANDS["ALLOW"] = "for x in one; do printf '%s\\n' once >> permission-count.txt; done"
    harness.COMMANDS["AFTER"] = "for x in one; do printf '%s\\n' after >> permission-after.txt; done"
    report = {"passed": False, "root": str(root), "provider": "local HTTP fixture", "checks": {}}
    print(json.dumps(report), flush=True)
    def keys(*args):
        probe.tm("send-keys", "-t", "probe:0.0", *args)
    def visible():
        return probe.tm("capture-pane", "-p", "-t", "probe:0.0")
    def permissions():
        probe.submit("/permissions")
        probe.wait(lambda: "Apply permissions to this Session" in visible(), "permission-picker")
    try:
        probe.tm("new-session", "-d", "-s", "probe", "-x", "143", "-y", "42", "-c", str(root / "workspace"), "sleep 3600")
        probe.tm("set-window-option", "-t", "probe:0", "remain-on-exit", "on")
        probe.tm("respawn-pane", "-k", "-t", "probe:0.0", "exec " + shlex.join([executable]))
        probe.wait(lambda: "Message RunLedger" in visible(), "startup", 40)
        probe.track_processes()
        session_ids = probe.session_ids()
        before = probe.submit("HARNESS_ALLOW")
        probe.approval()
        probe.save_frame("pending")
        keys("/")
        probe.wait(lambda: "Apply permissions to this Session" in visible(), "pending-picker")
        keys("Escape")
        probe.approval()
        keys("/")
        probe.wait(lambda: "Apply permissions to this Session" in visible(), "pending-picker-again")
        keys("Down", "Down", "Enter")
        probe.wait(lambda: "Confirm Full Access" in visible(), "confirmation")
        probe.save_frame("confirm")
        keys("Enter")
        report["checks"]["pending_continued"] = probe.end(before, "stop")
        assert (root / "workspace/permission-count.txt").read_text() == "once\n"
        permissions()
        assert "Full Access (current)" in visible()
        probe.save_frame("applied")
        keys("Escape")
        probe.wait(lambda: "Apply permissions to this Session" not in visible(), "picker-closed")
        before = probe.submit("HARNESS_AFTER")
        report["checks"]["next_tool"] = probe.end(before, "stop")
        assert (root / "workspace/permission-after.txt").read_text() == "after\n"
        permissions()
        assert "Full Access (current)" in visible()
        probe.save_frame("current-full-access")
        keys("Up", "Up", "Enter")
        probe.wait(lambda: "Apply permissions to this Session" not in visible(), "tightened")
        permissions()
        assert "Ask for approval (current)" in visible()
        keys("Escape")
        probe.wait(lambda: "Apply permissions to this Session" not in visible(), "tightened-picker-closed")
        before = probe.submit("HARNESS_CANCEL")
        probe.approval()
        probe.save_frame("tightened-prompt")
        keys("Escape")
        report["checks"]["tightened_cancel"] = probe.end(before, "aborted")
        assert not (root / "workspace/forbidden.txt").exists()
        assert probe.session_ids() == session_ids
        report["session_ids"] = session_ids
        with sqlite3.connect(root / "home/state.db") as db:
            records = [(kind, json.loads(payload)) for kind, payload in db.execute("SELECT event_type,payload_json FROM session_events WHERE event_type IN ('session.security.update','approval.superseded','approval.requested') ORDER BY sequence")]
        report["permission_events"] = records
        assert len([item for kind, item in records if kind == "approval.superseded"]) == 1
        assert len([item for kind, item in records if kind == "approval.requested"]) == 2
        assert [item["profile"] for kind, item in records if kind == "session.security.update" and item["stage"] == "applied"] == ["danger-full-access", "workspace-write"]
        permission_contexts = ["\n".join(str(message.get("content", "")) for message in request.get("messages", [])
                                             if message.get("role") in ("system", "developer")) for request in server.wire_requests]
        assert any("profile: danger-full-access; revision: 2" in context for context in permission_contexts)
        assert "profile: workspace-write; revision: 3" in permission_contexts[-1]
        report["checks"]["model_context_updated"] = True
        keys("Escape")
        time.sleep(0.3)
        report["exit_code"] = probe.close()
        report["passed"] = True
    finally:
        report["surviving_processes"] = harness.cleanup(probe)
        server.shutdown(); server.server_close()
        report["passed"] = report["passed"] and not report["surviving_processes"]
        (root / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report), flush=True)

if __name__ == "__main__":
    main()
