#!/usr/bin/env python3
"""分轮执行开发案例；记录中断/恢复证据，不把模型结束当功能验收通过。"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time

from driver import Case, summarize_turn


def files(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file() and not path.is_symlink()
            and "node_modules" not in path.parts and ".git" not in path.parts}


def session_ids(case):
    import sqlite3
    from contextlib import closing
    with closing(sqlite3.connect((case.root / "home/state.db").as_uri() + "?mode=ro", uri=True)) as conn:
        return [row[0] for row in conn.execute("SELECT session_id FROM sessions ORDER BY session_id")]


def run_case(root, case_id, verification, prompts):
    root.mkdir()
    case = Case(root, case_id, verification)
    case.prepare()
    report = {"case": case_id, "status": "running", "rounds": [], "artifact_dir": str(root)}
    started = time.monotonic()

    def persist():
        report["wall_seconds"] = round(time.monotonic() - started, 3)
        (root / "case-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    try:
        case.launch()
        report["initial_session_ids"] = session_ids(case)
        persist()
        previous = case.submit(prompts[case_id][0], "round-1")
        if case_id == "06-csv":
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                observed = files(root / "workspace")
                events = [event for seq, event in case.events() if seq > previous]
                if any(event.get("type") == "agent_end" for event in events):
                    raise RuntimeError("Task ended before a partial-source interruption could be observed")
                sources = [name for name in observed if name.endswith((".py", ".ts", ".js")) and "test" not in name.lower()]
                if sources:
                    report["before_interrupt"] = {"files": observed,
                        "completed_tools": [event.get("toolName") for event in events if event.get("type") == "tool_execution_end"]}
                    case.capture("before-interrupt")
                    case.tm("send-keys", "-t", case.target, "C-c")
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError("No partial source file appeared within interruption deadline")
            result = case.wait_turn(previous, "interrupted", timeout=60)
            terminal = next(event for event in reversed(result["events"]) if event.get("type") == "agent_end")
            report["interruption_stop_reason"] = terminal.get("stopReason")
            if terminal.get("stopReason") != "aborted":
                raise RuntimeError("Ctrl+C did not produce an aborted run")
            report["rounds"].append(summarize_turn(result, None))
            report["first_cli_exit"] = case.close()
            if report["first_cli_exit"] != 0:
                raise RuntimeError("Interrupted session failed clean CLI exit")
            shutil.copytree(root / "workspace", root / "interruption-workspace", symlinks=True,
                            ignore=shutil.ignore_patterns("node_modules", ".git"))
            report["files_after_exit"] = files(root / "workspace")
            case.launch(resume=True)
            report["resumed_session_ids"] = session_ids(case)
            if report["resumed_session_ids"] != report["initial_session_ids"]:
                raise RuntimeError("Resume opened a different Session")
            report["files_after_resume"] = files(root / "workspace")
            if report["files_after_resume"] != report["files_after_exit"]:
                raise RuntimeError("Workspace changed during session restart")
            persist()
            previous = case.submit(prompts[case_id][1], "round-2-resumed")
            result = case.wait_turn(previous, "round-2-resumed", timeout=900)
        else:
            result = case.wait_turn(previous, "round-1", timeout=900)
            if case_id == "02-tasks":
                first = summarize_turn(result, None)
                report["rounds"].append(first)
                if first["agent_stop_reason"] != "stop" or first["model_errors"]:
                    raise RuntimeError("Round one did not complete successfully")
                shutil.copytree(root / "workspace", root / "round-1-workspace", symlinks=True,
                                ignore=shutil.ignore_patterns("node_modules", ".git"))
                report["round_1_files"] = files(root / "workspace")
                persist()
                previous = case.submit(prompts[case_id][1], "round-2-tags")
                result = case.wait_turn(previous, "round-2-tags", timeout=900)
                report["round_2_files"] = files(root / "workspace")
        exit_code = case.close()
        final = summarize_turn(result, exit_code)
        report["rounds"].append(final)
        report["status"] = final["status"]
        report["files"] = files(root / "workspace")
    except Exception as error:
        report.update(status="failed_execution", error=str(error))
        try:
            case.capture("suite-failure")
            report["cleanup_cli_exit"] = case.close()
        except Exception:
            report["cleanup_cli_exit"] = None
            try:
                case.tm("kill-server")
            except Exception:
                pass
    persist()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verification", type=Path, required=True)
    parser.add_argument("--cases", nargs="+", default=["01-jsonl", "02-tasks", "06-csv"])
    parser.add_argument("--jobs", type=int, default=3)
    args = parser.parse_args()
    prompts = json.loads(Path(__file__).with_name("prompts.json").read_text())
    if not 1 <= args.jobs <= 3 or any(case not in prompts for case in args.cases):
        parser.error("jobs must be 1..3 and case names must exist in prompts.json")
    root = Path(tempfile.mkdtemp(prefix="runledger-dev-suite-"))
    print("Artifacts:", root, flush=True)
    results = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        pending = [pool.submit(run_case, root / case, case, args.verification, prompts) for case in args.cases]
        for future in as_completed(pending):
            report = future.result()
            results.append(report)
            print(json.dumps({key:report[key] for key in ("case", "status", "wall_seconds")}, ensure_ascii=False), flush=True)
            (root / "suite-report.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if all(row["status"] == "awaiting_independent_verification" for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
