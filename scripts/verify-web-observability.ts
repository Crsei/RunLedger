/** 隔离规模/浏览器验收；先 npm run build，再 npx tsx scripts/verify-web-observability.ts [seconds] [report.json]。 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem, release } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServerHarness } from "../tests/runtime/session-server/harness.ts";
import { createRuntimeId } from "../src/runtime/protocol/ids.ts";
import { standardHarnessProfileRef } from "../src/runtime/harness-profiles/index.ts";
import { appendEventInTransaction } from "../src/storage/session-store/event-append.ts";
import { openSessionDatabase } from "../src/storage/session-store/database.ts";

const exec = promisify(execFile);
const seconds = Number(process.argv[2] ?? 1800), reportPath = resolve(process.argv[3] ?? "/tmp/runledger-web-acceptance.json");
if (!Number.isSafeInteger(seconds) || seconds < 10) throw new Error("seconds must be at least 10");
const name = `runledger-web-acceptance-${process.pid}`, h = await createServerHarness();
let web: ReturnType<typeof spawn> | undefined, interval: ReturnType<typeof setInterval> | undefined;
const memory: { elapsedSeconds: number; ownerRss: number; webRss: number; browserHeap: number | null }[] = [];
const browser = async (...args: string[]): Promise<Record<string, unknown>> => {
  const { stdout } = await exec("agent-browser", ["--session", name, ...args, "--json"], { maxBuffer: 4 * 1024 * 1024 });
  const value = JSON.parse(stdout) as { success: boolean; data: Record<string, unknown> };
  if (!value.success) throw new Error("browser command failed");
  return value.data;
};
const evaluate = async <T>(expression: string): Promise<T> => (await browser("eval", expression)).result as T;
const percentile = (values: readonly number[], p: number): number | null => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null;
const rss = (pid: number): number => {
  try { return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) * 1024; } catch { return 0; }
};
const runtimeRss = (): number => {
  if (!web?.pid) return 0;
  try {
    const children = readFileSync(`/proc/${web.pid}/task/${web.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
    return children.reduce((sum, pid) => sum + rss(pid), 0);
  } catch { return 0; }
};
try {
  console.log("Creating 1000 isolated sessions and 100000 events");
  for (let i = 0; i < 999; i++) h.store.createSession({ sessionId: createRuntimeId("session", `scale-${i}`), workspaceId: createRuntimeId("workspace", "w"), repositoryId: createRuntimeId("repository", "r"), settingsDigest: "a".repeat(64), harnessProfile: standardHarnessProfileRef() });
  const db = openSessionDatabase(resolve(h.dir, "state.db"));
  db.runSync("UPDATE sessions SET created_at_ms=0 WHERE session_id<>?", [h.sessionId]);
  let serial = 0;
  const append = (text: string) => h.store.appendEvent(h.fence, { eventId: createRuntimeId("event", `web-scale-${++serial}`), ownerGeneration: h.fence.generation, eventType: "ledger.message",
    payloadJson: JSON.stringify({ payload: { message: { role: "assistant", content: [{ type: "text", text }] } } }), createdAtMs: Date.now(), expectedPreviousEventHash: h.store.latestEventHead(h.sessionId).hash });
  const seedStart = performance.now();
  for (let i = h.store.latestEventHead(h.sessionId).sequence; i < 100000;) {
    let previous = h.store.latestEventHead(h.sessionId).hash;
    db.withImmediateTransactionSync((tx) => {
      const end = Math.min(100000, i + 1000);
      for (; i < end; i++) {
        const event = appendEventInTransaction(tx, h.fence, { eventId: createRuntimeId("event", `web-scale-${++serial}`), ownerGeneration: h.fence.generation, eventType: "ledger.message",
          payloadJson: JSON.stringify({ payload: { message: { role: "assistant", content: [{ type: "text", text: `Scale history ${i}` }] } } }), createdAtMs: Date.now(), expectedPreviousEventHash: previous });
        previous = event.currentEventHash;
      }
    });
    await delay(0);
    if (i % 20000 === 0) console.log(`Seeded ${i} events`);
  }
  db.close();
  const seedMs = performance.now() - seedStart;
  web = spawn("runledger", ["web"], { env: { ...process.env, RUNLEDGER_DIR: h.dir }, stdio: ["ignore", "pipe", "pipe"] });
  let startup = ""; web.stdout!.on("data", (chunk) => { startup += String(chunk); });
  for (let i = 0; i < 200 && !startup.includes("http://"); i++) { if (web.exitCode !== null) throw new Error("Web CLI exited before startup"); await delay(50); }
  const loginUrl = startup.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*/)?.[0];
  if (!loginUrl) throw new Error("Web startup missing");
  const origin = new URL(loginUrl).origin;
  await browser("open", loginUrl); startup = "";
  console.log("Opened first browser tab", origin);
  console.log(JSON.stringify(await browser("errors")));
  await browser("wait", ".session-card");
    await browser("click", ".session-card:first-child");
  await evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(document.querySelectorAll('.measured-row').length){clearInterval(timer);resolve(true)}else if(Date.now()-start>10000){clearInterval(timer);reject(Error('snapshot timeout'))}},20)})`);
  const warm = await evaluate<number[]>(`(async()=>{const samples=[];for(let i=0;i<30;i++){const start=performance.now();const r=await fetch('/api/v1/sessions/${h.sessionId}/snapshot');if(!r.ok)throw Error('snapshot failed');await r.json();samples.push(performance.now()-start)}return samples})()`);
  const warmUi = await evaluate<number[]>(`(async()=>{const samples=[];const waitFor=(test)=>new Promise((resolve,reject)=>{const start=performance.now();const poll=()=>{if(test())requestAnimationFrame(()=>requestAnimationFrame(resolve));else if(performance.now()-start>10000)reject(Error('UI timeout'));else setTimeout(poll,5)};poll()});for(let i=0;i<20;i++){document.querySelector('.session-toolbar button').click();await waitFor(()=>document.querySelector('.session-card'));const start=performance.now();document.querySelector('.session-card').click();await waitFor(()=>document.querySelector('.measured-row'));samples.push(performance.now()-start)}return samples})()`);
  const tabList = await browser("tab", "list");
  const tabs = (tabList.tabs as { tabId: string }[] | undefined) ?? [];
  const tabIds: string[] = [tabs[0]?.tabId ?? "t1"];
  for (let i = 1; i < 10; i++) {
    console.log(`Opening observer ${i}`);
    const opened = await browser("tab", "new", "--label", `observer-${i}`, origin);
    tabIds.push(`observer-${i}`); void opened;
    await browser("wait", ".session-card");
    await browser("click", ".session-card:first-child");
  }
  const metadata = await evaluate<{ userAgent: string }>("({userAgent:navigator.userAgent})");
  for (const tab of tabIds) {
    await browser("tab", tab);
    await evaluate(`(()=>{window.__webLatency=new Map();const update=()=>{for(const match of document.body.textContent.matchAll(/WEB_LATENCY:(\\d+):(\\d+)/g)){if(!window.__webLatency.has(match[2]))window.__webLatency.set(match[2],Date.now()-Number(match[1]))}};new MutationObserver(update).observe(document.querySelector('main'),{subtree:true,childList:true,characterData:true});return true})()`);
  }
  const started = Date.now(); let ticks = 0;
  interval = setInterval(() => append(`WEB_LATENCY:${Date.now()}:${++ticks}`), 1000);
  const latency: number[] = [];
  console.log(`Observing ten browser tabs for ${seconds} seconds`);
  do {
    const heap = await evaluate<number | null>("performance.memory?.usedJSHeapSize ?? null");
    memory.push({ elapsedSeconds: (Date.now() - started) / 1000, ownerRss: process.memoryUsage().rss, webRss: runtimeRss(), browserHeap: heap });
    writeFileSync(reportPath, JSON.stringify({ status: "running", sessions: 1000, initialEvents: 100000, observers: 10, seedMs, elapsedSeconds: (Date.now() - started) / 1000, memory }, null, 2));
    await delay(Math.min(10000, Math.max(1, seconds * 1000 - (Date.now() - started))));
  } while (Date.now() - started < seconds * 1000);
  clearInterval(interval); interval = undefined; await delay(1000);
  const perObserver: { tab: string; samples: number; p95Ms: number | null; domRows: number }[] = [];
  for (const tab of tabIds) {
    await browser("tab", tab);
    const result = await evaluate<{ values: number[]; rows: number }>("({values:[...window.__webLatency.values()],rows:document.querySelectorAll('.measured-row').length})");
    latency.push(...result.values); perObserver.push({ tab, samples: result.values.length, p95Ms: percentile(result.values, .95), domRows: result.rows });
  }
  await browser("screenshot", reportPath.replace(/\.json$/, ".png"));
  await browser("tab", "close", tabIds[0]); await browser("tab", tabIds.at(-1)!);
  append("WEB_SURVIVING_OBSERVER");
  const survivesFirstTabClose = await evaluate<boolean>(`new Promise((resolve)=>{const start=Date.now();const poll=()=>{if(document.body.textContent.includes('WEB_SURVIVING_OBSERVER'))resolve(true);else if(Date.now()-start>5000)resolve(false);else setTimeout(poll,20)};poll()})`);
  await h.server.close();
  const coldStarted = performance.now(), coldSamples: { scanned: number; rss: number }[] = [];
  const cancellation = await evaluate<boolean>(`(async()=>{const controller=new AbortController();const request=fetch('/api/v1/sessions/${h.sessionId}/trajectory',{signal:controller.signal});controller.abort();try{await request;return false}catch(error){return error.name==='AbortError'}})()`);
  let coldHealth = "rebuilding", coldScanned = 0;
  for (let batch = 0; batch < 100 && coldHealth === "rebuilding"; batch++) {
    const progress = await evaluate<{ health: string; scanned: number }>(`(async()=>{let page;for(let i=0;i<20;i++){const r=await fetch('/api/v1/sessions/${h.sessionId}/trajectory');if(!r.ok)throw Error('cold read failed');page=await r.json();if(page.health!=='rebuilding')break;}return {health:page.health,scanned:page.scannedEvents}})()`);
    coldHealth = progress.health; coldScanned = progress.scanned; coldSamples.push({ scanned: coldScanned, rss: runtimeRss() });
  }
  const cold = { elapsedMs: performance.now() - coldStarted, cancelled: cancellation, health: coldHealth, scanned: coldScanned, samples: coldSamples };
  const report = { status: "complete", hardware: { cpu: cpus()[0]?.model, cpus: cpus().length, memoryBytes: totalmem(), kernel: release(), node: process.version }, browser: metadata,
    sessions: 1000, initialEvents: 100000, observers: 10, durationSeconds: (Date.now() - started) / 1000, seedMs,
    survivesFirstTabClose, warmFirstScreenUiP95Ms: percentile(warmUi, .95), coldRebuild: cold, warmSnapshotHttpP95Ms: percentile(warm, .95), durableToDomP95Ms: percentile(latency, .95), perObserver, memory,
    driverClaimEvents: h.store.readEventRange(h.sessionId, { after: 100000, limit: 4096 }).filter((event) => event.eventType === "driver.claimed").length,
    limits: "Synthetic scale fixture with real Owner TCP and built CLI/HTTP/browser; separate real Agent execution and TUI throughput evidence required." };
  writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(`Report: ${reportPath}`);
} catch (error) {
  await browser("screenshot", reportPath.replace(/\.json$/, ".failure.png")).catch(() => undefined);
  console.log(JSON.stringify(await browser("errors").catch(() => ({ diagnostic: "browser unavailable" }))));
  const body = await evaluate<string>("document.body.innerText").catch(() => "browser unavailable");
  writeFileSync(reportPath, JSON.stringify({ status: "failed", body, error: error instanceof Error ? error.message.replace(/http:\/\/127\.0\.0\.1:\d+\/#[^\s]+/g, "[login link]") : "unknown" }, null, 2));
  throw new Error("Web acceptance failed; inspect the report");
} finally {
  clearInterval(interval);
  await browser("close").catch(() => undefined);
  if (web && web.exitCode === null) { web.kill("SIGTERM"); await new Promise<void>((resolve) => web!.once("close", () => resolve())); }
  h.owner.release("detached"); await h.server.close(); h.cleanup();
}
