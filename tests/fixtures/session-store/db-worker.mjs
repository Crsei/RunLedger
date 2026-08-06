/**
 * R1 真实多进程测试用的 SQLite worker fixture。
 *
 * 使用 node:sqlite 直接操作同一 DB 文件,不依赖本仓库 TS 模块,
 * 用于证明“两个真实 Node 进程争抢同一 DB”的跨进程语义。
 *
 * 用法:node db-worker.mjs <command> <dbPath> <workDir>
 * 命令:
 *   open             打开并查询 PRAGMA(证明并发 open)
 *   install          安装 DDL(SESSION_STORE_DDL 环境变量)并打印 header
 *   hold-write       持有写事务,等待 <workDir>/release 文件出现后 COMMIT
 *   write-attempt    busy_timeout=100 下尝试 INSERT,打印 {busy} 或 {ok}
 *   crash-mid-write  BEGIN IMMEDIATE + INSERT 后直接 exit(1)(模拟崩溃)
 *   read-count       打印 sessions 行数
 *   set-version <v>  把 schema_meta.schema_version 改成 v(模拟新旧 binary)
 */

import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, dbPath, workDir] = process.argv.slice(2);
const out = (value) => {
  writeFileSync(join(workDir, "result.json"), JSON.stringify(value));
  process.stdout.write(JSON.stringify(value) + "\n");
};

function open() {
  const db = new DatabaseSync(dbPath, {});
  chmodSync(dbPath, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 100");
  db.exec("PRAGMA trusted_schema = OFF");
  return db;
}

function install(db) {
  db.exec(process.env.SESSION_STORE_DDL ?? "");
  db.prepare("INSERT INTO schema_meta (schema_version, format_digest, applied_at_ms) VALUES (1, ?, 1)").run(
    process.env.SESSION_STORE_FORMAT_DIGEST ?? "d".repeat(64),
  );
  db.prepare("INSERT INTO store_control (singleton_id, admission, migration_epoch, updated_at_ms) VALUES (1, 'ready', 0, 1)").run();
}

try {
  if (command === "open") {
    const db = open();
    const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
    out({ ok: true, journalMode: mode, pid: process.pid });
    db.close();
  } else if (command === "install") {
    const db = open();
    install(db);
    const meta = db.prepare("SELECT schema_version, format_digest FROM schema_meta").get();
    out({ ok: true, pid: process.pid, schemaVersion: meta.schema_version, formatDigest: meta.format_digest });
    db.close();
  } else if (command === "hold-write") {
    const db = open();
    db.exec("BEGIN IMMEDIATE");
    writeFileSync(join(workDir, "lock-held"), String(process.pid));
    const releaseFile = join(workDir, "release");
    const deadline = Date.now() + 20_000;
    while (!existsSync(releaseFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    db.exec("COMMIT");
    out({ ok: true, pid: process.pid, released: existsSync(releaseFile) });
    db.close();
  } else if (command === "write-attempt") {
    const db = open();
    const started = Date.now();
    try {
      db.prepare("INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES ('s_w', 'ws', 'r', 'active', 1, 1, 'd')").run();
      out({ ok: true, pid: process.pid, waitMs: Date.now() - started });
    } catch (error) {
      out({ busy: error.errcode === 5, pid: process.pid, waitMs: Date.now() - started, errcode: error.errcode, message: String(error.message).slice(0, 60) });
    }
    db.close();
  } else if (command === "crash-mid-write") {
    const db = open();
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES ('s_crash', 'ws', 'r', 'active', 1, 1, 'd')").run();
    process.stdout.write("in-transaction\n");
    process.exit(1);
  } else if (command === "read-count") {
    const db = open();
    const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    out({ ok: true, pid: process.pid, count: row.n });
    db.close();
  } else if (command === "set-version") {
    const db = open();
    const version = Number(process.argv.slice(2)[3]);
    db.prepare("UPDATE schema_meta SET schema_version = ?, format_digest = ? WHERE schema_version = 1").run(version, "f".repeat(64));
    out({ ok: true, pid: process.pid, version });
    db.close();
  } else {
    out({ error: `unknown command: ${command}` });
    process.exit(2);
  }
} catch (error) {
  out({ error: String(error.message ?? error).slice(0, 200) });
  process.exit(3);
}
