#!/usr/bin/env python3
"""真实 CLI 的原生流式 compact 与 length 恢复；仅连接临时本地 TLS 代理夹具。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time

from compaction import records
from run import Probe, cleanup


class NativeProvider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        if self.path != "api.openai.com:443":
            self.send_error(403)
            return
        self.send_response(200, "Connection Established")
        self.end_headers()
        self.wfile.flush()
        connection = self.server.tls.wrap_socket(self.connection, server_side=True)
        self.connection = connection
        self.rfile = connection.makefile("rb")
        self.wfile = connection.makefile("wb")
        self.close_connection = False
        self.handle_one_request()
        self.close_connection = True
        connection.close()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        self.server.requests.append(body)
        assert self.path == "/v1/responses", self.path
        inputs = body.get("input", [])
        trigger = inputs and inputs[-1].get("type") == "compaction_trigger"
        users = [entry for entry in inputs if entry.get("role") == "user"]
        latest = json.dumps(users[-1]) if users else ""
        incomplete = not trigger and "NATIVE_LENGTH_ONCE" in latest and not self.server.length_seen
        if trigger:
            assert body["store"] is False and body["stream"] is True
            assert body.get("prompt_cache_key") and self.headers.get("session_id")
            item = {"type": "compaction", "id": "cmp_fixture", "encrypted_content": "opaque-cli-native"}
        elif incomplete:
            self.server.length_seen = True
            item = {"type": "function_call", "id": "fc_incomplete", "call_id": "call_incomplete", "name": "bash",
                    "arguments": json.dumps({"command": "printf forbidden > native-forbidden.txt"}), "status": "incomplete"}
        else:
            item = {"type": "message", "id": "msg_" + str(len(self.server.requests)), "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "NATIVE_LONG_HISTORY " + "original evidence " * 1100, "annotations": []}]}
        usage = {"input_tokens": 200, "output_tokens": 100, "total_tokens": 300,
                 "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}
        status = "incomplete" if incomplete else "completed"
        response = {"id": "response_fixture", "status": status, "output": [item], "usage": usage}
        if incomplete:
            response["incomplete_details"] = {"reason": "max_output_tokens"}
        events = [{"type": "response.output_item.done", "output_index": 0, "item": item},
                  {"type": "response." + status, "response": response}]
        payload = "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()
        self.close_connection = True


def main():
    root = Path(tempfile.mkdtemp(prefix="runledger-native-compact-cli-"))
    cert, key = root / "fixture-cert.pem", root / "fixture-key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.openai.com",
                    "-addext", "subjectAltName=DNS:api.openai.com", "-addext", "basicConstraints=critical,CA:TRUE",
                    "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
    key.chmod(0o600)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    server = ThreadingHTTPServer(("127.0.0.1", 0), NativeProvider)
    server.tls, server.requests, server.length_seen = tls, [], False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    probe = Probe(shutil.which("runledger"), root, server.server_port)
    probe.env.pop("LITELLM_BASE_URL", None)
    probe.env.update({"OPENAI_API_KEY": "fixture-only", "RUNLEDGER_PROXY_OPENAI": f"http://127.0.0.1:{server.server_port}",
                      "NODE_EXTRA_CA_CERTS": str(cert), "SSL_CERT_FILE": str(cert)})
    probe.settings.update({"provider": "openai", "model": "gpt-4.1", "compaction": {"strategy": "openai-responses-native", "nativeMode": "streaming", "retainRecentTokens": 1000, "auto": True, "threshold": 0.95}})
    probe.write_settings()
    report = {"passed": False, "root": str(root), "executable": str(probe.executable), "provider": "local TLS proxy fixture; real OpenAI remains pending"}
    try:
        probe.start()
        for index in range(3):
            before = probe.submit(f"NATIVE_HISTORY_{index}")
            probe.end(before, "stop")
            time.sleep(0.5)
        raw = records(probe, "ledger.message")
        probe.submit("/compact --strategy=openai-responses-native")
        probe.wait(lambda: len(records(probe, "compaction.completed")) == 1, "native compact", 40)
        assert records(probe, "ledger.message") == raw
        report["first_exit"] = probe.close()
        probe.start(resume=True)
        before = probe.submit("NATIVE_AFTER_RESUME")
        probe.end(before, "stop")
        inputs = server.requests[-1]["input"]
        assert sum(item.get("type") == "compaction" for item in inputs) == 1
        assert "opaque-cli-native" in json.dumps(inputs) and "NATIVE_HISTORY_0" in json.dumps(inputs)
        time.sleep(0.5)
        before = probe.submit("NATIVE_LENGTH_ONCE")
        probe.end(before, "stop", 40)
        completed = records(probe, "compaction.completed")
        assert len(completed) == 2 and completed[-1]["checkpoint"]["reason"] == "incomplete"
        assert not (root / "workspace/native-forbidden.txt").exists()
        assert "not executed" in json.dumps(records(probe, "ledger.message"))
        report["second_exit"] = probe.close()
        report.update({"streaming_native_and_restart": True, "length_recovery_without_tool_execution": True, "passed": True})
    finally:
        server.shutdown()
        server.server_close()
        report["remaining_owned_pids"] = cleanup(probe)
        key.unlink(missing_ok=True)
        (root / "result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report), flush=True)
    assert not report["remaining_owned_pids"]


if __name__ == "__main__":
    main()
