"""模型失败与 CLI 正常退出必须独立判定。"""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from driver import Case, summarize_turn


class OutcomeTests(unittest.TestCase):
    def test_uses_user_model_and_keeps_credentials_out_of_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "settings.json").write_text(json.dumps({
                "provider": "deepseek", "model": "deepseek-v4-pro", "thinkingLevel": "high"}))
            sentinel = "test-only-credential-not-for-network"
            (source / "auth.json").write_text(json.dumps({"deepseek": {"type": "api_key", "key": sentinel}}))
            manifest_path = source / "state/model-compatibility/manifest.json"
            manifest_path.parent.mkdir(parents=True)
            manifest = {"version": 1, "profiles": [], "aliases": {}}
            manifest_path.write_text(json.dumps(manifest))
            artifacts = root / "artifacts"
            artifacts.mkdir()
            with patch.dict(os.environ, {"RUNLEDGER_DIR": str(source)}, clear=True):
                case = Case(artifacts, "03-rename")
                case.prepare()
            settings = json.loads((artifacts / "home/settings.json").read_text())
            self.assertEqual((settings["provider"], settings["model"], settings["thinkingLevel"]),
                             ("deepseek", "deepseek-v4-pro", "high"))
            self.assertEqual(case.env["DEEPSEEK_API_KEY"], sentinel)
            self.assertNotIn("LITELLM_API_KEY", case.env)
            self.assertEqual(json.loads((artifacts / "home/state/model-compatibility/manifest.json").read_text()), manifest)
            for path in artifacts.rglob("*"):
                if path.is_file():
                    self.assertNotIn(sentinel, path.read_text())

    def test_provider_error_is_not_success_when_cli_exits_zero(self):
        result = {"duration_seconds": 1, "events": [
            {"type": "message_end", "role": "assistant", "stopReason": "error",
             "message": {"errorMessage": "403 insufficient_user_quota"}},
            {"type": "agent_end", "stopReason": "error", "activeDurationMs": 345},
        ]}
        summary = summarize_turn(result, 0)
        self.assertEqual(summary["status"], "failed_model")
        self.assertFalse(summary["task_acceptance_passed"])
        self.assertEqual(summary["tool_calls_completed"], 0)

    def test_model_completion_still_needs_independent_acceptance(self):
        result = {"duration_seconds": 1, "events": [{"type": "agent_end", "stopReason": "stop"}]}
        summary = summarize_turn(result, 0)
        self.assertEqual(summary["status"], "awaiting_independent_verification")
        self.assertFalse(summary["task_acceptance_passed"])


if __name__ == "__main__":
    unittest.main()
