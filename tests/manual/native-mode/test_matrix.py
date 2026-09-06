"""用同步屏障验证真实并发调度及单例失败后的完整汇总。"""

import argparse
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from run_matrix import run_matrix


class MatrixTests(unittest.TestCase):
    def test_concurrent_cases_keep_failures_and_separate_artifacts(self):
        barrier = threading.Barrier(2, timeout=5)
        lock = threading.Lock()
        active = peak = 0
        roots = []

        class FakeProbe:
            def __init__(self, args, root):
                self.args, self.root = args, root

            def run(self):
                nonlocal active, peak
                with lock:
                    roots.append(self.root)
                    active += 1
                    peak = max(peak, active)
                try:
                    if self.args.mode != "plan":
                        barrier.wait()
                    if self.args.mode == "minimal":
                        raise RuntimeError("synthetic case failure")
                    return {"passed": True, "exit_code": 0}
                finally:
                    with lock:
                        active -= 1

        cases = [dict(mode=mode, theme="dark", width=80) for mode in ("default", "minimal", "plan")]
        with tempfile.TemporaryDirectory() as directory, patch("run_matrix.Probe", FakeProbe):
            root = Path(directory)
            summary = run_matrix(cases, root, argparse.Namespace(jobs=2))
            self.assertEqual(peak, 2)
            self.assertEqual(len(set(roots)), 3)
            self.assertFalse(summary["passed"])
            self.assertEqual(summary["total"], 3)
            self.assertEqual(summary["by_mode"]["plan"], {"passed": 1, "failed": 0})
            self.assertEqual(summary["by_mode"]["minimal"], {"passed": 0, "failed": 1})
            self.assertIn("synthetic case failure", summary["cases"][1]["error"])
            for row in summary["cases"]:
                self.assertEqual(json.loads((Path(row["artifact_dir"]) / "case.json").read_text()), row)
            self.assertEqual(json.loads((root / "summary.json").read_text()), summary)
            self.assertIn("FAIL", (root / "summary.md").read_text())


if __name__ == "__main__":
    unittest.main()
