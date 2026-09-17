import { useEffect, useState } from "react";
import type { WebProcesses, WebChildren, WebPlan } from "../contracts/index.ts";
import { ChildDrawer } from "./children/ChildDrawer.tsx";
import { ApiError, get, query, errorText } from "../lib/api.ts";

type Capability = WebProcesses | WebChildren | WebPlan;
export function Capabilities({ id, kind, revision }: { id: string; kind: string; revision: number }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [value, setValue] = useState<Capability | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await get<Capability>(`/api/v1/sessions/${id}/${kind}${query({ cursor })}`, controller.signal);
        if (!controller.signal.aborted) { setValue(result); setError(""); }
      } catch (e) { if (!controller.signal.aborted) { setError(errorText(e)); if (e instanceof ApiError && e.code === "resync_required") setCursor(null); } }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), document.hidden ? 10000 : 3000);
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, kind, revision, cursor]);
  if (error) return <div className="error">{error}</div>;
  if (!value) return <div className="empty">正在读取…</div>;
  if (!value.available) return <div className="empty">{value.reason === "offline" ? "Owner 离线，无法查询当前运行状态。" : value.reason === "not-equipped" ? "此会话未装配该能力。" : "此记录不可用。"}</div>;
  if ("summary" in value) return <div className="panel-scroll"><h3>计划状态</h3><pre>{value.summary}</pre></div>;
  const child = value.items.find((item) => item.id === selected && "sessionId" in item) as Extract<WebChildren, { available: true }>["items"][number] | undefined;
  return <div className="panel-scroll">{value.items.length === 0 && <div className="empty">暂无记录</div>}{value.items.map((item) => <article className="tool-card" key={item.id}><header><strong>{"label" in item ? item.label : "子任务"}</strong><span>{item.state}</span></header>{"sessionId" in item && <button onClick={() => setSelected(item.id)}>查看子任务</button>}<pre>{"outputPreview" in item ? item.outputPreview || "暂无输出" : item.summary}</pre>{"truncated" in item && item.truncated && <p className="muted">仅显示有界输出预览；完整输出可在终端查询。</p>}</article>)}{value.after && <button onClick={() => { setCursor(value.after); setSelected(null); }}>更多记录</button>}{cursor && <button onClick={() => setCursor(null)}>返回首屏</button>}{child && <ChildDrawer child={child} close={() => setSelected(null)} />}</div>;
}
