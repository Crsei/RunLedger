"""驱动器故障路径回归；真实运行 tmux，使用本地失败程序，不调用 provider。"""

import argparse
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

from run import Probe, database_evidence


class DatabaseTests(unittest.TestCase):
    def test_missing_database_is_not_created(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.db"
            with self.assertRaises(sqlite3.OperationalError):
                database_evidence(path)
            self.assertFalse(path.exists())


@unittest.skipUnless(shutil.which("tmux"), "tmux required")
class LifecycleTests(unittest.TestCase):
    def probe(self, shell):
        with tempfile.TemporaryDirectory(prefix="rl-driver-test-") as directory:
            root = Path(directory)
            binary = root / "candidate with spaces"
            binary.write_text("#!/bin/sh\n" + shell + "\n", encoding="utf-8")
            binary.chmod(0o700)
            args = argparse.Namespace(executable=str(binary), mode="default", theme="dark",
                                      timeout=0.5, width=100, height=30)
            probe = Probe(args, root)
            result = probe.run()
            self.assertFalse(result["passed"])
            self.assertTrue((root / "result.json").exists())
            self.assertNotIn("cleanup_error", result)
            return result

    def test_immediate_exit_is_failure_even_with_zero_code(self):
        result = self.probe("exit 0")
        self.assertIn("exited during startup: 0", result["error"])

    def test_fatal_frame_is_failure(self):
        result = self.probe("printf 'TypeError: synthetic failure\\n'; exec sleep 30")
        self.assertIn("fatal error", result["error"])

    def test_unready_process_times_out(self):
        result = self.probe("exec sleep 30")
        self.assertIn("Timed out during startup", result["error"])


if __name__ == "__main__":
    unittest.main()
