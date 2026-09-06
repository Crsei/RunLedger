/** 隔离数据的轨迹压力测量；不读取用户配置或凭据。 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { buildRunledgerLayout } from "../src/runtime/contracts/storage-layout.ts";
import type { TrajectoryPage } from "../src/runtime/contracts/trajectory.ts";
import { openSessionDatabase } from "../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../src/storage/session-store/schema.ts";
import { SessionStore } from "../src/storage/session-store/session-store.ts";
import { JsonlTraceEventStore } from "../src/runtime/trace/event-store.ts";
import { canonicalDigest } from "../src/runtime/protocol/canonical-json.ts";
import { TrajectoryService } from "../src/runtime/trajectory/service.ts";

const root = await mkdtemp(join(tmpdir(), "runledger-trajectory-benchmark-"));
process.env.RUNLEDGER_DIR = root;
const layout = buildRunledgerLayout(root, "posix");
const db = openSessionDatabase(layout.database);
installSessionStoreSchema(db);
const sessionId = "session_benchmark";
const service = new TrajectoryService({ layout, store: new SessionStore(db), sessionId, generation: 1, config: { mode: "events", failurePolicy: "best_effort" } });
const path = join(layout.events, "2026", "09", "06", "trace_benchmark.jsonl");
const events = new JsonlTraceEventStore({ filePath: path, traceId: "trace_benchmark" });
const total = 100_000;
let rssPeak = process.memoryUsage().rss;
const monitor = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 100);
try {
  const start = performance.now();
  for (let offset = 0; offset < total; offset += 128) {
    await Promise.all(Array.from({ length: Math.min(128, total - offset) }, (_, n) => {
      const i = offset + n;
      return events.append({ eventId: `event_${i}`, traceId: "trace_benchmark", nodeId: i === 0 ? "trace_benchmark" : `tool_${i}`,
        parentNodeId: i === 0 ? null : "trace_benchmark", kind: i === 0 ? "trace" : "tool", name: `fixture.tool.${i}`,
        phase: "finished", timestamp: new Date(1_000 + i).toISOString(), durationMs: 1,
        metadata: { sessionId, runId: "benchmark", ownerGeneration: 1, ...(i === 0 ? {} : { toolCallId: `call_${i}` }) } });
    }));
  }
  await events.close();
  const writeMs = performance.now() - start;
  const rebuildStart = performance.now();
  let page: TrajectoryPage;
  while (true) {
    const result = await service.query("trajectory.page", {});
    if (!result.ok) throw new Error(result.code);
    page = result.value as unknown as TrajectoryPage;
    if (page.status.health !== "rebuilding") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (page.status.records !== total || page.status.health !== "ready") throw new Error(`incomplete index: ${page.status.records} / ${page.status.health}`);
  const rebuildMs = performance.now() - rebuildStart;
  const times: number[] = [];
  let maxPageBytes = 0;
  for (let i = 0; i < 100; i++) {
    const begin = performance.now();
    const result = await service.query(i % 2 ? "trajectory.search" : "trajectory.page", i % 2 ? { search: "fixture.tool.9", pageSize: 200 } : { pageSize: 200 });
    times.push(performance.now() - begin);
    if (!result.ok) throw new Error(result.code);
    maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(result)));
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ events: total, writeMs, rebuildMs, queryP95Ms: times[94], maxPageBytes, eventBytes: (await stat(path)).size, cacheBytes: (await stat(join(layout.projections, "trajectory", canonicalDigest(sessionId) + ".sqlite"))).size, rssPeakBytes: rssPeak }, null, 2));
} finally { clearInterval(monitor); await service.close(); db.close(); await rm(root, { recursive: true, force: true }); }
