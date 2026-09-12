#!/usr/bin/env python3
"""独立验收生成物；保留每条命令的退出码和真实输出，不修正模型代码。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


class Acceptance:
    def __init__(self, root):
        self.root = root.resolve()
        self.workspace = self.root / "workspace"
        self.commands = []
        self.checks = []

    def run(self, argv, cwd=None, stdin=None):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", RUNLEDGER_DIR=str(self.root / "home"))
        result = subprocess.run([str(arg) for arg in argv], cwd=cwd or self.workspace,
                                input=stdin, capture_output=True, text=True, timeout=60, env=env)
        self.commands.append({"argv": [str(arg) for arg in argv], "cwd": str(cwd or self.workspace),
                              "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        return result

    def check(self, label, condition):
        self.checks.append({"name": label, "passed": bool(condition)})

    def rename(self):
        tool = self.workspace / "rename_files.py"
        result = self.run([sys.executable, "test_rename.py"])
        self.check("generated regression tests", result.returncode == 0)
        with tempfile.TemporaryDirectory(prefix="rl-accept-rename-") as directory:
            root = Path(directory)
            (root / "中文 空格.TXT").write_text("original")
            (root / "nested").mkdir()
            (root / "nested/leave ME.TXT").write_text("nested")
            (root / "link ME.TXT").symlink_to("中文 空格.TXT")
            result = self.run([sys.executable, tool, root])
            self.check("preview preserves original names", result.returncode == 0 and (root / "中文 空格.TXT").exists())
            result = self.run([sys.executable, tool, root, "--apply"])
            self.check("apply preserves content and skips symlink/subdirectory", result.returncode == 0
                       and (root / "中文_空格.txt").read_text() == "original"
                       and (root / "link ME.TXT").is_symlink() and (root / "nested/leave ME.TXT").exists())
        with tempfile.TemporaryDirectory(prefix="rl-accept-conflict-") as directory:
            root = Path(directory)
            for name in ["a b.TXT", "a_b.txt", "other FILE.TXT"]:
                (root / name).write_text(name)
            before = {path.name: path.read_bytes() for path in root.iterdir()}
            result = self.run([sys.executable, tool, root, "--apply"])
            self.check("conflict leaves whole batch byte-identical", result.returncode != 0
                       and before == {path.name: path.read_bytes() for path in root.iterdir()})
        with tempfile.TemporaryDirectory(prefix="rl-accept-extension-") as directory:
            root = Path(directory)
            (root / "中文 A.T XT").write_text("extension-space")
            result = self.run([sys.executable, tool, root, "--apply"])
            self.check("spaces anywhere in filename become underscores", result.returncode == 0
                       and (root / "中文_A.t_xt").exists())

    def markdown(self):
        tool = self.workspace / "check_md_links.py"
        result = self.run([sys.executable, "-m", "unittest", "-v", "test_check_md_links"])
        self.check("generated regression tests", result.returncode == 0)
        samples = [
            ("valid relative fragment", "[ok](exists.txt#part)\n", 0, ""),
            ("broken source line and target", "heading\n[bad](gone.txt#part)\n", 1, "a.md:2: gone.txt#part"),
            ("external/mail/anchor", "[a](https://example.com) [b](mailto:a@b) [c](#part)\n", 0, ""),
            ("backtick fence", "```python\n[x](absent.txt)\n```\n", 0, ""),
            ("tilde fence", "~~~~\n[x](absent.txt)\n~~~~\n", 0, ""),
            ("short fence does not close long fence", "````\n```\n[x](absent.txt)\n````\n", 0, ""),
            ("text after fence marker is not a closing fence", "```\n``` not-a-close\n[x](absent.txt)\n```\n", 0, ""),
            ("Chinese angle destination", "[ok](<中文 文件.txt>)\n", 0, ""),
        ]
        for label, body, code, output in samples:
            with tempfile.TemporaryDirectory(prefix="rl-accept-md-") as directory:
                root = Path(directory)
                (root / "a.md").write_text(body)
                (root / "exists.txt").write_text("present")
                (root / "中文 文件.txt").write_text("present")
                result = self.run([sys.executable, tool, root])
                self.check(label, result.returncode == code and (output in result.stdout if output else result.stdout == ""))

    def jsonl(self):
        cli = [self.workspace / ".runtime/bun", self.workspace / "cli.ts"]
        records = [{"level": "INFO" if i < 4 else "WARN", "service": "中文服务" if i in (0, 1, 4, 5) else "api",
                    "duration": duration, "message": "记录 " + str(i)}
                   for i, duration in enumerate((9, 9, 7, 6, 5, 2))]
        body = "\n".join(json.dumps(row, ensure_ascii=False) for row in records) + "\n{broken\n"
        with tempfile.TemporaryDirectory(prefix="rl-accept-jsonl-") as directory:
            root = Path(directory)
            source = root / "日志 数据.jsonl"
            source.write_text(body)
            result = self.run([*cli, source, "--format", "json"])
            value = json.loads(result.stdout)
            self.check("counts and Chinese fields match manual totals", result.returncode == 0
                       and value["stats"] == {"level": {"INFO": 4, "WARN": 2}, "service": {"中文服务": 4, "api": 2}})
            self.check("top five and equal-duration order", [row["line"] for row in value["topDuration"]] == [1, 2, 3, 4, 5])
            self.check("bad line reported on stderr and processing continues", value["badLines"] == 1 and "7" in result.stderr)
            result = self.run([*cli, source, "--service", "中文服务", "--format", "json"])
            value = json.loads(result.stdout)
            self.check("service filter", result.returncode == 0 and value["matched"] == 4
                       and value["stats"]["level"] == {"INFO": 2, "WARN": 2})
            source.write_text("")
            result = self.run([*cli, source, "--format", "json"])
            value = json.loads(result.stdout)
            self.check("empty file", result.returncode == 0 and value["matched"] == 0 and value["topDuration"] == [] and not result.stderr)
            result = self.run([*cli, root / "missing.jsonl", "--format", "json"])
            self.check("missing input is an explicit error", result.returncode != 0 and bool(result.stderr))
            result = self.run([*cli, "--format", "json"], stdin=body)
            self.check("advertised stdin mode", result.returncode == 0 and json.loads(result.stdout)["matched"] == 6)

    def tasks(self):
        bun = self.workspace / ".runtime/bun"
        cli = [bun, self.workspace / "src/cli.ts"]
        old_cli = [bun, self.root / "round-1-workspace/src/cli.ts"]
        result = self.run([bun, "test", "tests/taskStore.test.ts"])
        self.check("generated round-two tests", result.returncode == 0)
        with tempfile.TemporaryDirectory(prefix="rl-accept-tasks-") as directory:
            root = Path(directory)
            for command in [["add", "买 牛奶 和面包"], ["add", "second task"], ["remove", "1"]]:
                result = self.run([*old_cli, *command], cwd=root)
                self.check("round-one fixture: " + " ".join(command), result.returncode == 0)
            source = root / "tasks.json"
            legacy_bytes = source.read_bytes()
            legacy = json.loads(legacy_bytes)
            self.check("fixture really predates tags", all("tags" not in task for task in legacy["tasks"]))
            result = self.run([*cli, "list", "--json"], cwd=root)
            rows = json.loads(result.stdout)
            self.check("legacy data readable without rewrite", result.returncode == 0 and rows[0]["id"] == 2
                       and rows[0]["tags"] == [] and source.read_bytes() == legacy_bytes)
            result = self.run([*cli, "add", "中文 标题 with spaces", "--tag", "重要"], cwd=root)
            value = json.loads(source.read_text())
            self.check("deleted IDs not reused across upgrade", result.returncode == 0 and value["tasks"][-1]["id"] == 3)
            self.check("Chinese and spaces persist", value["tasks"][-1]["title"] == "中文 标题 with spaces")
            result = self.run([*cli, "list", "--tag", "重要", "--json"], cwd=root)
            rows = json.loads(result.stdout)
            self.check("tag filter and parseable JSON", result.returncode == 0 and len(rows) == 1 and rows[0]["id"] == 3)
            result = self.run([*cli, "done", "2"], cwd=root)
            self.check("done works on legacy task", result.returncode == 0 and json.loads(source.read_text())["tasks"][0]["done"])
            for broken in ('{"tasks":', '{"nextId":1,"tasks":"broken"}'):
                source.write_text(broken)
                for command in [["add", "new"], ["list", "--json"], ["done", "2"], ["remove", "2"]]:
                    result = self.run([*cli, *command], cwd=root)
                    self.check("corrupt file preserved: " + " ".join(command), result.returncode != 0 and bool(result.stderr)
                               and source.read_text() == broken)
        with tempfile.TemporaryDirectory(prefix="rl-accept-empty-tag-") as directory:
            root = Path(directory)
            self.run([*cli, "add", "existing"], cwd=root)
            source = root / "tasks.json"
            before = source.read_bytes()
            result = self.run([*cli, "add", "new", "--tag", ""], cwd=root)
            listed = self.run([*cli, "list", "--json"], cwd=root)
            self.check("empty tag is rejected without corrupting valid data", result.returncode != 0
                       and source.read_bytes() == before and listed.returncode == 0)

    def csv(self):
        cli = [self.workspace / ".runtime/bun", self.workspace / "main.ts"]
        body = ('g,v\n"华,东",1.5\n"华,东","2.5"\n"华,东",\n"华,东",oops\n'
                '"a""b",-2\n"跨\n行",3e1\n,0\n坏,NaN\n坏,Infinity\n坏,\n')
        expected = {
            "华,东": (2, 4, 1.5, 2.5), 'a"b': (1, -2, -2, -2), "跨\n行": (1, 30, 30, 30),
            "": (1, 0, 0, 0), "坏": (0, 0, None, None),
        }
        with tempfile.TemporaryDirectory(prefix="rl-accept-csv-") as directory:
            root = Path(directory)
            source = root / "引号 空值.csv"
            source.write_text(body)
            args = ["--group", "g", "--value", "v", "--format", "json"]
            result = self.run([*cli, source, *args])
            rows = json.loads(result.stdout)
            actual = {row["g"]: tuple(row["v_" + field] for field in ("count", "sum", "min", "max")) for row in rows}
            self.check("quoted commas, escaped quotes, multiline groups", result.returncode == 0
                       and all(actual.get(key) == expected[key] for key in ("华,东", 'a"b', "跨\n行")))
            self.check("empty groups and invalid/empty numeric values", actual.get("") == expected[""] and actual.get("坏") == expected["坏"])
            result = self.run([*cli, "-", *args], stdin=body)
            self.check("CSV stdin", result.returncode == 0 and json.loads(result.stdout) == rows)
            result = self.run([*cli, source, "--group", "missing", "--value", "v"])
            self.check("unknown column rejected", result.returncode != 0 and bool(result.stderr))
            source.write_text("g,v\n")
            result = self.run([*cli, source, *args])
            self.check("header-only input", result.returncode == 0 and json.loads(result.stdout) == [])
        tests = sorted(path for path in self.workspace.glob("*.ts") if "test" in path.name)
        for test in tests:
            command = "test" if "bun:test" in test.read_text() else "run"
            result = self.run([self.workspace / ".runtime/bun", command, test])
            self.check("generated CSV regression tests: " + test.name, result.returncode == 0)

    def save(self):
        report = {"case": self.root.name, "checks": self.checks, "commands": self.commands,
                  "passed": all(row["passed"] for row in self.checks),
                  "tested_source_sha256": {str(path.relative_to(self.workspace)): hashlib.sha256(path.read_bytes()).hexdigest()
                                           for path in self.workspace.rglob("*") if path.is_file() and path.suffix in (".py", ".ts")},
                  "validation_environment": "independent host subprocesses; distinct from RunLedger tool environment"}
        (self.root / "independent-acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({key: report[key] for key in ("case", "checks", "passed")}, ensure_ascii=False))
        return report["passed"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", choices=("rename", "markdown", "jsonl", "tasks", "csv"))
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    acceptance = Acceptance(args.root)
    getattr(acceptance, args.case)()
    return 0 if acceptance.save() else 1


if __name__ == "__main__":
    raise SystemExit(main())
