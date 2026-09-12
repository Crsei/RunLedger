#!/usr/bin/env python3
"""同一用户库的多 Session 权限切换；真实 CLI/TTY，模型仅使用本地 fixture。"""

from contextlib import closing
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
    root = Path(tempfile.mkdtemp(prefix="runledger-permission-cross-session-"))
    server = harness.ThreadingHTTPServer(("127.0.0.1", 0), harness.Provider)
    server.requests, server.wire_requests = [], []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    executable = shutil.which("runledger")
    assert Path(executable).resolve() == REPO / "bin/runledger.js"
    probe = harness.Probe(executable, root, server.server_port)
    report = {"passed": False, "root": str(root), "sessions": [], "exit_codes": []}
    print(json.dumps(report), flush=True)

    def visible():
        return probe.tm("capture-pane", "-p", "-t", "probe:0.0")

    def keys(*args):
        probe.tm("send-keys", "-t", "probe:0.0", *args)

    def permissions():
        probe.submit("/permissions")
        probe.wait(lambda: "Apply permissions to this Session" in visible(), "permission-picker")

    try:
        probe.tm("new-session", "-d", "-s", "probe", "-x", "143", "-y", "42", "-c", str(root / "workspace"), "sleep 3600")
        probe.tm("set-window-option", "-t", "probe:0", "remain-on-exit", "on")
        for index in range(2):
            # 仅重置隔离目录的默认权限；两个会话的审计记录必须保留在同一 SQLite 库。
            probe.settings["security"] = {"profile": "workspace-write"}
            probe.write_settings()
            probe.tm("respawn-pane", "-k", "-t", "probe:0.0", "exec " + shlex.join([executable]))
            probe.wait(lambda: "Message RunLedger" in visible(), "startup", 40)
            probe.track_processes()
            # 留下一轮真实本地请求，避免空会话退出时被清理。
            before = probe.submit("HARNESS_AFTER")
            probe.end(before, "stop")
            permissions()
            assert "Ask for approval (current)" in visible()
            keys("Down", "Down", "Enter")
            probe.wait(lambda: "Confirm Full Access" in visible(), "confirmation")
            probe.save_frame(f"session-{index}-confirmation")
            keys("Enter")
            probe.wait(lambda: "Permissions applied to this Session and saved as the default." in visible(), "applied")
            permissions()
            assert "Full Access (current)" in visible()
            probe.save_frame(f"session-{index}-applied")
            keys("Escape")
            probe.wait(lambda: "Apply permissions to this Session" not in visible(), "picker-closed")
            harness.COMMANDS["ALLOW"] = f"for x in one; do printf '%s\\n' once >> permission-{index}.txt; done"
            before = probe.submit("HARNESS_ALLOW")
            probe.end(before, "stop")
            assert (root / f"workspace/permission-{index}.txt").read_text() == "once\n"
            keys("Escape")
            time.sleep(0.3)
            report["exit_codes"].append(probe.close())
            assert len(probe.session_ids()) == index + 1

        with closing(sqlite3.connect((root / "home/state.db").as_uri() + "?mode=ro", uri=True)) as db:
            records = [(sid, event_id, json.loads(payload)) for sid, event_id, payload in db.execute(
                "SELECT session_id,event_id,payload_json FROM session_events WHERE event_type='session.security.update' ORDER BY created_at_ms,sequence")]
            assert db.execute("SELECT count(*) FROM session_events WHERE event_type='approval.requested'").fetchone()[0] == 0
            assert db.execute("SELECT count(*) FROM session_owners WHERE state!='unowned'").fetchone()[0] == 0
        report["sessions"] = probe.session_ids()
        report["permission_events"] = records
        assert len(records) == 4
        assert len({event_id for _, event_id, _ in records}) == 4
        assert len({record["updateId"] for _, _, record in records}) == 1
        for sid in report["sessions"]:
            assert [record["stage"] for session, _, record in records if session == sid] == ["prepared", "applied"]
        report["passed"] = True
    finally:
        report["surviving_processes"] = harness.cleanup(probe)
        server.shutdown(); server.server_close()
        report["passed"] = report["passed"] and not report["surviving_processes"]
        (root / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
