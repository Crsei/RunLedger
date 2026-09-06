#!/usr/bin/env python3
"""并发运行独立 TUI 用例，分别保存证据并汇总为 JSON / Markdown。"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import itertools
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

from run import Probe


def run_case(case, root, options, epoch):
    started = time.monotonic()
    args = argparse.Namespace(**vars(options), **case)
    try:
        result = Probe(args, root).run()
    except Exception as error:
        # 单个驱动器异常仍要进入汇总，不取消其他独立用例。
        result = {"passed": False, "error": f"{type(error).__name__}: {error}"}
        (root / "driver-error.txt").write_text(result["error"] + "\n", encoding="utf-8")
    finished = time.monotonic()
    row = {**result, **case, "artifact_dir": str(root),
           "passed": result.get("passed") is True and result.get("exit_code") == 0,
           "started_after_seconds": round(started - epoch, 6),
           "finished_after_seconds": round(finished - epoch, 6),
           "duration_seconds": round(finished - started, 3)}
    (root / "case.json").write_text(
        json.dumps(row, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return row


def run_matrix(cases, root, options):
    epoch = time.monotonic()
    results = [None] * len(cases)
    with ThreadPoolExecutor(max_workers=options.jobs) as executor:
        futures = {}
        for index, case in enumerate(cases):
            case_root = root / f"{index + 1:03d}-{case['mode']}-{case['theme']}-{case['width']}"
            case_root.mkdir()
            futures[executor.submit(run_case, case, case_root, options, epoch)] = index
        for future in as_completed(futures):
            results[futures[future]] = future.result()
    events = sorted((row[key], delta) for row in results for key, delta in (
        ("started_after_seconds", 1), ("finished_after_seconds", -1)))
    active = peak = 0
    for _, delta in events:
        active += delta
        peak = max(peak, active)
    by_mode = {}
    for row in results:
        counts = by_mode.setdefault(row["mode"], {"passed": 0, "failed": 0})
        counts["passed" if row["passed"] else "failed"] += 1
    summary = {"passed": bool(results) and all(row["passed"] for row in results),
               "jobs": options.jobs, "peak_active_cases": peak,
               "duration_seconds": round(time.monotonic() - epoch, 3),
               "total": len(results), "by_mode": by_mode, "cases": results}
    (root / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# Native mode 并发测试结果", "",
             f"结果：{'PASS' if summary['passed'] else 'FAIL'}；总数：{len(results)}；"
             f"并发上限：{options.jobs}；活动用例峰值：{peak}；耗时：{summary['duration_seconds']} 秒。", "",
             "| 模式 | 通过 | 失败 |", "|---|---:|---:|"]
    for mode, counts in by_mode.items():
        lines.append(f"| {mode} | {counts['passed']} | {counts['failed']} |")
    lines.extend(["", "| 用例 | 结果 | 耗时（秒） | CLI 退出码 | 证据 |",
                  "|---|---|---:|---:|---|"])
    for row in results:
        directory = Path(row["artifact_dir"]).name
        lines.append(f"| {directory} | {'PASS' if row['passed'] else 'FAIL'} | "
                     f"{row['duration_seconds']} | {row.get('exit_code', '未正常退出')} | "
                     f"[结果]({directory}/case.json) |")
    lines.extend(["", "失败原因及每例开始/结束时间见 summary.json。活动用例峰值包含准备与清理时间，"
                  "不等同于同时处于输入就绪状态的 TUI 数量。", ""])
    (root / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--modes", nargs="+", choices=("default", "minimal", "plan"),
                        default=["default", "minimal", "plan"])
    parser.add_argument("--themes", nargs="+", choices=("dark", "light"), default=["dark", "light"])
    parser.add_argument("--widths", nargs="+", type=int, default=[80, 143])
    parser.add_argument("--height", type=int, default=42)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--executable", default="runledger")
    parser.add_argument("--output-parent", type=Path, default=Path(tempfile.gettempdir()))
    args = parser.parse_args()
    if not 1 <= args.jobs <= 16 or min(args.widths) < 40 or args.height < 20 or not 0 < args.timeout <= 120:
        parser.error("1 <= jobs <= 16, widths >= 40, height >= 20, 0 < timeout <= 120 required")
    if not shutil.which("tmux"):
        parser.error("tmux is required")
    root = Path(tempfile.mkdtemp(prefix="runledger-mode-matrix-", dir=args.output_parent)).resolve()
    print(f"Artifacts: {root}", flush=True)
    cases = [dict(mode=mode, theme=theme, width=width)
             for theme, width, mode in itertools.product(args.themes, args.widths, args.modes)]
    summary = run_matrix(cases, root, args)
    print((root / "summary.md").read_text(encoding="utf-8"))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
