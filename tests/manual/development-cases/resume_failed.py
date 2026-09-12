#!/usr/bin/env python3
"""中断门禁失败后的恢复诊断；不把强制退出改记为正常中断通过。"""

import argparse
import json
from pathlib import Path
import shutil
import time

from driver import Case, summarize_turn
from run_suite import files, session_ids


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--case", choices=("02-tasks", "06-csv"), default="06-csv")
    parser.add_argument("--verification", type=Path, required=True)
    args = parser.parse_args()
    case = Case(args.root, args.case, args.verification)
    report = {"status": "running", "normal_interrupt_passed": False,
              "socket": case.socket, "session_ids_before": session_ids(case),
              "files_before": files(args.root / "workspace")}
    target = args.root / "recovery-report.json"
    target.write_text(json.dumps(report, indent=2))
    shutil.copytree(args.root / "workspace", args.root / ("round-1-workspace" if args.case == "02-tasks" else "forced-exit-workspace"))
    started = time.monotonic()
    try:
        case.launch(resume=True)
        report["session_ids_after"] = session_ids(case)
        report["files_after_restart"] = files(args.root / "workspace")
        if report["session_ids_after"] != report["session_ids_before"]:
            raise RuntimeError("Resume changed Session ID")
        if report["files_after_restart"] != report["files_before"]:
            raise RuntimeError("Resume changed workspace files")
        target.write_text(json.dumps(report, indent=2))
        prompts = json.loads(Path(__file__).with_name("prompts.json").read_text())
        previous = case.submit(prompts[args.case][1], "forced-recovery")
        result = case.wait_turn(previous, "forced-recovery", timeout=900)
        report["round"] = summarize_turn(result, case.close())
        report["status"] = report["round"]["status"]
    except Exception as error:
        report.update(status="failed_execution", error=str(error))
        try:
            case.capture("recovery-failure")
            case.close()
        except Exception:
            case.tm("kill-server")
    report["wall_seconds"] = round(time.monotonic() - started, 3)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["status"] == "awaiting_independent_verification" else 1


if __name__ == "__main__":
    raise SystemExit(main())
