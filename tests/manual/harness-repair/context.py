#!/usr/bin/env python3
"""复用 Harness repair 的真实 CLI/TTY 夹具，验证超过请求预算的历史投影。"""

import argparse
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time

from run import Probe, Provider, REPO, cleanup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", default=str(REPO / "bin/runledger.js"))
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="runledger-harness-context-"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    server.requests = []
    server.wire_requests = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    probe = Probe(args.executable, root, server.server_port)
    probe.settings["agentMode"] = "minimal"
    probe.write_settings()
    report = {"passed": False, "root": str(root), "executable": str(probe.executable),
              "model": "local HTTP fixture via catalogued LiteLLM model; not a real-provider run"}
    print(json.dumps(report), flush=True)
    try:
        report["dist_files_sha256"] = {
            str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((REPO / "dist").rglob("*")) if path.is_file()
        }
        probe.start()
        for index in range(16):
            text = f"CONTEXT_ROUND_{index:02d} " + "abcdefghij " * 3600
            before = sum(event.get("type") == "agent_end" for event in probe.events())
            # load-buffer 避免 tmux 命令参数长度上限；bracketed paste 保持完整输入。
            (root / "paste.txt").write_text(text)
            probe.tm("load-buffer", str(root / "paste.txt"))
            probe.tm("paste-buffer", "-p", "-t", "probe:0.0")
            time.sleep(0.6)
            probe.tm("send-keys", "-t", "probe:0.0", "Enter")
            probe.end(before, "stop", 40)
            assert len(server.wire_requests) == index + 1
            time.sleep(0.3)
        latest = server.wire_requests[-1]
        wire = json.dumps(latest)
        assert latest["model"] == "claude-opus-4-8"
        assert "CONTEXT_ROUND_15" in wire
        assert "CONTEXT_ROUND_00" not in wire
        selected = [item for item in latest["messages"] if item.get("role") == "user"]
        assert 0 < len(selected) < 16
        raw = [event["message"] for event in probe.events()
               if event.get("type") == "message_end" and event.get("message", {}).get("role") == "user"]
        assert len(raw) == 16
        for index in range(16):
            assert f"CONTEXT_ROUND_{index:02d}" in json.dumps(raw[index])
        report["checks"] = {"recent_kept": True, "old_omitted": True,
                            "wire_user_count": len(selected), "raw_user_count": len(raw)}
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
        (root / "wire-requests.json").write_text(json.dumps(server.wire_requests))
        (root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({key: value for key, value in report.items() if key != "dist_files_sha256"}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
