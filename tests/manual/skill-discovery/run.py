#!/usr/bin/env python3
"""标准 PATH CLI 的 Skill 自动发现、信任、reload 与按需正文加载；仅用隔离本地 fixture。"""

import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("harness_fixture", REPO / "tests/manual/harness-repair/run.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
BODY = "SKILL_BODY_AUTODISCOVERY_SENTINEL"


class Provider(harness.Provider):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        self.server.wire_requests.append(request)
        messages = request.get("messages", [])
        index = max((i for i, message in enumerate(messages) if message.get("role") == "user"), default=-1)
        user = str(messages[index].get("content", "")) if index >= 0 else ""
        has_result = any(message.get("role") == "tool" for message in messages[index + 1:])
        if "LOAD_SKILL" in user and not has_result:
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_skill", "type": "function",
                     "function": {"name": "Skill", "arguments": json.dumps({"name": "aaa"})}}]}
            finish = "tool_calls"
        else:
            delta, finish = {"role": "assistant", "content": "FIXTURE_DONE"}, "stop"
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


def main():
    root = Path(tempfile.mkdtemp(prefix="runledger-skill-discovery-"))
    server = harness.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    server.requests, server.wire_requests = [], []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    executable = shutil.which("runledger")
    assert Path(executable).resolve() == REPO / "bin/runledger.js"
    probe = harness.Probe(executable, root, server.server_port)
    report = {"root": str(root), "passed": False, "provider": "local fixture"}
    print(json.dumps(report), flush=True)

    def skill(directory, name, body="Unloaded fixture body"):
        target = directory / name / "SKILL.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"---\nname: {name}\ndescription: {name} fixture\n---\n{body}\n")

    def visible():
        return probe.tm("capture-pane", "-p", "-t", "probe:0.0")

    def keys(*args):
        probe.tm("send-keys", "-t", "probe:0.0", *args)

    def idle():
        probe.wait(lambda: "Mode:" in "\n".join(visible().splitlines()[-5:]) and "Working" not in visible(), "idle")

    try:
        locations = [
            (root / "user/.omp/agent/skills", "aaa"),
            (root / "workspace/.omp/skills", "omp-project"),
            (root / "user/.codex/skills", "codex-user"),
            (root / "workspace/.codex/skills", "codex-project"),
            (root / "user/.agents/skills", "agents-user"),
            (root / "workspace/.agents/skills", "agents-project"),
            (root / "user/.claude/skills", "claude-user"),
            (root / "workspace/.claude/skills", "claude-project"),
        ]
        for directory, name in locations:
            skill(directory, name, BODY if name == "aaa" else "Unloaded fixture body")
        assert "skills" not in probe.settings
        probe.start()
        before = probe.submit("BEFORE_TRUST")
        probe.end(before, "stop")
        assert BODY not in json.dumps(server.wire_requests)
        idle()
        probe.submit("/skill")
        probe.wait(lambda: "/skills (8)" in visible(), "automatic-discovery")
        probe.save_frame("automatic-discovery")
        # a 不与 modal 的 t/r 快捷键冲突，过滤到 OMP 用户 Skill。
        keys("a", "a", "a")
        probe.wait(lambda: "> aaa" in visible(), "filter")
        keys("t")
        probe.wait(lambda: "> aaa" in visible() and "(untrusted" not in visible(), "exact-trust")
        probe.save_frame("trusted")
        skill(root / "user/.agents/skills", "newly-added")
        keys("r")
        time.sleep(1)
        keys("Escape")
        probe.wait(lambda: "Review discovered skills" not in visible(), "closed")
        time.sleep(.3)
        probe.submit("/skill")
        probe.wait(lambda: "/skills (9)" in visible(), "reload-new-skill")
        probe.save_frame("reloaded")
        keys("Escape")
        probe.wait(lambda: "Review discovered skills" not in visible(), "closed-after-reload")
        time.sleep(.3)
        wire_index = len(server.wire_requests)
        before = probe.submit("LOAD_SKILL")
        probe.end(before, "stop")
        wires = server.wire_requests[wire_index:]
        assert len(wires) >= 2
        assert "qualifiedId=skill:" in json.dumps(wires[0]) and "name=aaa" in json.dumps(wires[0])
        assert BODY not in json.dumps(wires[0])
        assert any(message.get("role") == "tool" and BODY in str(message.get("content"))
                   for request in wires[1:] for message in request.get("messages", []))
        assert "Unloaded fixture body" not in json.dumps(server.wire_requests)
        probe.save_frame("body-loaded")
        report["checks"] = ["8 default directories", "skill alias", "exact trust", "reload", "catalog-only initial request", "Skill tool body result"]
        report["exit_code"] = probe.close()
        report["passed"] = True
    finally:
        report["surviving_processes"] = harness.cleanup(probe)
        server.shutdown()
        server.server_close()
        report["passed"] = report["passed"] and not report["surviving_processes"]
        (root / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
