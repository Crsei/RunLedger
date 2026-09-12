#!/usr/bin/env python3
"""对用户指定 DeepSeek 模型做真实工具往返探测，仅生成隔离测试准入记录。"""

from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import time
import urllib.request

from driver import REPO, digest, user_model_config


def _lookup_model(entry: dict, model_id: str) -> dict:
    # data/<provider>.json 现按 api 分组;兼容仍在使用的扁平结构。
    if isinstance(entry.get(model_id), dict):
        return entry[model_id]
    for group in entry.values():
        if isinstance(group, dict) and isinstance(group.get(model_id), dict):
            return group[model_id]
    raise KeyError(model_id)


def main():
    root = Path(tempfile.mkdtemp(prefix="runledger-user-model-probe-"))
    print("Artifacts:", root, flush=True)
    config = user_model_config()
    started = time.monotonic()
    catalog = _lookup_model(
        json.loads((REPO / "src/providers/data/deepseek.json").read_text()), config["model"]
    )
    tools = [{"type": "function", "function": {"name": "verify_echo",
              "description": "Echo the supplied text", "parameters": {"type": "object",
              "properties": {"text": {"type": "string"}}, "required": ["text"]}}}]
    messages = [{"role": "user", "content": "请调用 verify_echo 工具，text 参数为 READY。收到工具结果后只回复该结果。"}]
    evidence = {"provider": config["provider"], "model": config["model"],
                "thinking": config["thinking"], "passed": False}

    def request():
        body = {"model": config["model"], "messages": messages, "tools": tools,
                "thinking": {"type": "enabled"}, "reasoning_effort": config["thinking"],
                "max_tokens": 2048, "stream": False}
        req = urllib.request.Request(catalog["baseUrl"].rstrip("/") + "/chat/completions",
            data=json.dumps(body).encode(), headers={"Content-Type": "application/json",
            "Authorization": "Bearer " + config["key"]})
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)

    try:
        first = request()
        assistant = first["choices"][0]["message"]
        calls = assistant.get("tool_calls", [])
        if len(calls) != 1 or calls[0]["function"]["name"] != "verify_echo":
            raise RuntimeError("Expected one verify_echo tool call")
        arguments = json.loads(calls[0]["function"]["arguments"])
        if arguments != {"text": "READY"}:
            raise RuntimeError("Unexpected echo arguments")
        messages.extend([assistant, {"role": "tool", "tool_call_id": calls[0]["id"], "content": "READY"}])
        second = request()
        answer = second["choices"][0]["message"]
        if (answer.get("content") or "").strip() != "READY" or answer.get("tool_calls"):
            raise RuntimeError("Model did not consume the tool result correctly")
        evidence.update(passed=True, returned_models=[first.get("model"), second.get("model")],
                        tool_arguments=arguments, response=answer["content"],
                        reasoning_observed=bool(assistant.get("reasoning_content")),
                        usage=[first.get("usage"), second.get("usage")])
    except Exception as error:
        evidence["error"] = type(error).__name__ + ": " + str(error)
    evidence["duration_seconds"] = round(time.monotonic() - started, 3)
    artifact = {"verification": evidence}
    if evidence["passed"]:
        profile = {"profileId": config["provider"] + "/" + config["model"],
                   "providerId": config["provider"], "modelId": config["model"],
                   "manifestVersion": "isolated-live-probe-" + datetime.now(timezone.utc).strftime("%Y%m%d"),
                   "manifestDigest": digest(evidence), "contextWindow": catalog["contextWindow"],
                   "maxOutputTokens": catalog["maxTokens"], "reasoningProtocol": "native",
                   "toolProtocol": "json", "imageInput": False, "compaction": "none", "status": "verified"}
        body = {"version": 1, "profiles": [profile], "aliases": {}}
        artifact["manifest"] = {**body, "manifestDigest": digest(body)}
    (root / "verification.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False), flush=True)
    return 0 if evidence["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
