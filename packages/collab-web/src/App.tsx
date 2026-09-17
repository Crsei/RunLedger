import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { WebProjectsPage, WebSessionsPage, WebTrajectoryPage, WebTrajectoryDetail } from "./contracts/index.ts";
import { ApiError, get, query, errorText } from "./lib/api.ts";
import { sessionEvents } from "./lib/events.ts";
import { WebSessionStore } from "./lib/session-store.ts";
import { Usage } from "./components/Usage.tsx";
import { Capabilities } from "./components/Capabilities.tsx";
import { Transcript } from "./components/transcript/Transcript.tsx";

function time(value: number) { return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function Trajectory({ id, revision, onDetail }: { id: string; revision: number; onDetail: (id: string, inputId?: string) => void }) {
  const [page, setPage] = useState<WebTrajectoryPage | null>(null), [search, setSearch] = useState(""), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await get<WebTrajectoryPage>(`/api/v1/sessions/${id}/trajectory${query({ search, cursor })}`, controller.signal);
        if (controller.signal.aborted) return;
        setPage(result); setError("");
        timer = setTimeout(() => void load(), result.health === "rebuilding" ? 100 : 2000);
      } catch (e) { if (!controller.signal.aborted) {
        setError(errorText(e)); if (e instanceof ApiError && e.code === "resync_required") setCursor(null);
        timer = setTimeout(() => void load(), 2000);
      } }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, search, cursor, revision]);
  return <div className="panel-scroll"><div className="toolbar"><input aria-label="搜索轨迹" placeholder="搜索运行、工具或错误…" value={search} onChange={(event) => { setSearch(event.target.value); setCursor(null); }} /><span className="muted">{page?.health} · {page?.coverage}</span></div>
    {error && <div className="error">{error}</div>}
    {page?.health === "rebuilding" && <div className="notice">重建历史索引：{page.scannedEvents} / {page.totalEvents ?? "未知"} 个事件。切换页面可取消当前请求。</div>}
    <div className="trajectory-list">{page?.items.map((record) => <button key={record.id} className={`trajectory-row kind-${record.kind}`} onClick={() => onDetail(record.id)}>
      <span className="kind-label">{record.kind}</span><div><strong>{record.name}</strong><p>{record.summary.slice(0, 160)}</p></div>
      <div className="record-stats"><span>{record.state}</span><small>{record.durationMs == null ? "—" : `${record.durationMs} ms`} · {record.costUsd == null ? "费用未知" : `$${record.costUsd.toFixed(5)}`}</small></div>
    </button>)}</div>
    {!page?.items.length && <div className="empty">暂无可显示的轨迹</div>}
    {page?.before && <button onClick={() => setCursor(page.before)}>更早的轨迹</button>}{cursor && <button onClick={() => setCursor(null)}>最新轨迹</button>}
  </div>;
}
function Detail({ sessionId, recordId, inputId, close }: { sessionId: string; recordId: string; inputId?: string; close: () => void }) {
  const [field, setField] = useState<"input" | "output">("output"), [detail, setDetail] = useState<WebTrajectoryDetail | null>(null), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController();
    void get<WebTrajectoryDetail>(`/api/v1/sessions/${sessionId}/trajectory/${field === "input" ? inputId ?? recordId : recordId}/detail${query({ field, cursor })}`, controller.signal).then((value) => { setDetail(value); setError(""); }).catch((e) => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [sessionId, recordId, inputId, field, cursor]);
  return <aside className="detail-drawer" aria-label="记录详情"><header><strong>记录详情</strong><button onClick={close} aria-label="关闭详情">×</button></header><div className="tabs">{(["input", "output"] as const).map((value) => <button className={field === value ? "selected" : ""} key={value} onClick={() => { setField(value); setCursor(null); }}>{value === "input" ? "输入" : "输出"}</button>)}</div><p className="muted">{detail?.availability}</p>{error && <div className="error">{error}</div>}<pre>{detail?.text || "此字段没有可用正文"}</pre>{detail?.next && <button onClick={() => setCursor(detail.next)}>下一页正文</button>}</aside>;
}
export function App() {
  const [projects, setProjects] = useState<WebProjectsPage | null>(null), [project, setProject] = useState(""), [sessions, setSessions] = useState<WebSessionsPage | null>(null);
  const [session, setSession] = useState(""), [tab, setTab] = useState("conversation"), [detail, setDetail] = useState<{ id: string; inputId?: string } | null>(null), [error, setError] = useState("");
  const [projectCursor, setProjectCursor] = useState<string | null>(null), [sessionCursor, setSessionCursor] = useState<string | null>(null), [status, setStatus] = useState("");
  const [timeFrom, setTimeFrom] = useState(0);
  const store = useMemo(() => new WebSessionStore(get, sessionEvents), []), view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() { try {
      const result = await get<WebProjectsPage>(`/api/v1/projects${query({ cursor: projectCursor })}`, controller.signal);
      if (controller.signal.aborted) return;
      setProjects(result); setError(""); setProject((current) => current || result.items[0]?.id || "");
    } catch (e) { if (!controller.signal.aborted) { setError(errorText(e)); if (e instanceof ApiError && e.code === "resync_required") setProjectCursor(null); } }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), document.hidden ? 10000 : 2000);
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [projectCursor]);
  useEffect(() => {
    if (!project) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() { try {
      const result = await get<WebSessionsPage>(`/api/v1/projects/${project}/sessions${query({ cursor: sessionCursor, status, timeFrom })}`, controller.signal);
      if (!controller.signal.aborted) { setSessions(result); setError(""); }
    } catch (e) { if (!controller.signal.aborted) { setError(errorText(e)); if (e instanceof ApiError && e.code === "resync_required") setSessionCursor(null); } }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), document.hidden ? 10000 : 2000);
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [project, sessionCursor, status, timeFrom]);
  useEffect(() => { if (session) store.select(session); return () => store.stop(); }, [session, store]);
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="/">◧ <span>RunLedger<small>PROJECT OBSERVATORY</small></span></a><div className="sidebar-label">项目 <span>{projects?.items.length ?? 0}</span></div>
    <nav>{projects?.items.map((item) => <button key={item.id} className={`project-link ${project === item.id ? "active" : ""}`} onClick={() => { setProject(item.id); setSession(""); setSessions(null); setSessionCursor(null); setDetail(null); }}><span className="project-icon">⌘</span><span className="project-name">{item.displayName}<small>{item.sessionCount} 个会话</small></span></button>)}</nav>
    {projects?.after && <button onClick={() => setProjectCursor(projects.after)}>更多项目</button>}{projectCursor && <button onClick={() => setProjectCursor(null)}>返回首屏</button>}
    <div className="sidebar-footer"><span className="dot" /> 本机只读连接<small>执行与审批仍在终端完成</small></div></aside>
    <main><header className="topbar"><div><span className="eyebrow">WORKSPACE / ACTIVITY</span><h1>{session ? view.snapshot?.session.title || "会话记录" : "项目运行记录"}</h1></div><span className="read-only">READ ONLY</span></header>
      {(error || (session && view.error)) && <div className="error" role="alert">{error || view.error}</div>}
      {!session ? <div className="project-content"><div className="summary-card"><div><span className="eyebrow">运行历史</span><h2>每一次执行，都有据可循。</h2><p>浏览对话、工具调用与运行轨迹。记录来自本机 RunLedger。</p></div><div className="summary-number">{projects?.items.find((item) => item.id === project)?.sessionCount ?? "—"}<small>SESSIONS</small></div></div>
        <div className="section-title"><h3>会话</h3><label>起始时间 <input aria-label="起始时间" type="datetime-local" onChange={(event) => { setTimeFrom(event.target.value ? new Date(event.target.value).getTime() : 0); setSessionCursor(null); }} /></label><select aria-label="筛选状态" value={status} onChange={(event) => { setStatus(event.target.value); setSessionCursor(null); }}><option value="">所有状态</option>{["active", "completed", "failed", "paused", "recovery_required", "archived"].map((value) => <option key={value}>{value}</option>)}</select></div>
        <Usage project={project} timeFrom={timeFrom} /><div className="session-list">{sessions?.items.map((item) => <button key={item.id} className="session-card" onClick={() => { setSession(item.id); setTab("conversation"); setDetail(null); }}><div className="session-icon">↳</div><div className="session-main"><strong>{item.title || "未命名会话"}</strong><small>{item.id}</small></div><span className={`status status-${item.status}`}>{item.status}</span><time>{time(item.updatedAtMs)}</time><span>→</span></button>)}</div>
        {!sessions?.items.length && <div className="empty">{projects?.items.length ? "当前范围暂无会话" : "暂无项目。用 CLI 开始一次任务后，记录会出现在这里。"}</div>}
        <div className="pagination">{sessions?.before && <button onClick={() => setSessionCursor(sessions.before)}>更早会话</button>}{sessionCursor && <button onClick={() => setSessionCursor(null)}>返回最新</button>}</div>
      </div> : <><div className="session-toolbar"><button onClick={() => { setSession(""); setDetail(null); }}>← 会话列表</button><span className="status">{view.snapshot?.session.status}</span><span className="muted">{view.stale ? "连接中断 · 数据可能滞后" : view.snapshot?.connection.state === "connected" ? "Owner 在线" : "Owner 离线 · 历史记录"}</span></div>
        <div className="tabs">{[["conversation", "对话"], ["trajectory", "运行轨迹"], ["processes", "进程"], ["children", "子任务"], ["plan", "计划"]].map(([key, label]) => <button key={key} className={tab === key ? "selected" : ""} onClick={() => { setTab(key); setDetail(null); }}>{label}</button>)}</div>
        <div className="session-body">{tab === "conversation" ? <Transcript key={session} rows={view.rows} before={view.before} loading={view.loading} paused={view.paused} pause={() => store.pause()} older={() => void store.older()} latest={() => store.latest()} onDetail={(id, inputId) => setDetail({ id, inputId })} /> : tab === "trajectory" ? <Trajectory key={session} id={session} revision={view.revision} onDetail={(id, inputId) => setDetail({ id, inputId })} /> : <Capabilities key={`${session}:${tab}`} id={session} kind={tab} revision={view.revision} />}</div>
      </>}
    </main>{session && detail && <Detail key={`${session}:${detail.id}`} sessionId={session} recordId={detail.id} inputId={detail.inputId} close={() => setDetail(null)} />}
  </div>;
}
