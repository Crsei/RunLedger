// Adapted from collab-web AgentDrawer lifecycle/disclosure; see THIRD_PARTY_NOTICES.md.
import { useEffect, useState } from "react";
import type { WebChildren, WebSnapshot, WebTimelinePage, WebTimelineRow } from "../../contracts/index.ts";
import { decideChildHistory } from "../../lib/child-history.ts";
import { get, query } from "../../lib/api.ts";
import { Markdown } from "../transcript/Markdown.tsx";

type Child = Extract<WebChildren, { available: true }>["items"][number];
export function ChildDrawer({ child, close }: { child: Child; close: () => void }) {
  const [rows, setRows] = useState<readonly WebTimelineRow[]>([]), [error, setError] = useState("");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  useEffect(() => {
    setRows([]); setError("");
    if (!child.sessionId) return;
    const controller = new AbortController(); let cursor: string | undefined, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let page: WebTimelinePage | null = null, failure: unknown;
      try {
        if (!cursor) {
          const snapshot = await get<WebSnapshot>(`/api/v1/sessions/${child.sessionId}/snapshot`, controller.signal);
          cursor = snapshot.resumeCursor; page = snapshot.timeline;
        } else page = await get<WebTimelinePage>(`/api/v1/sessions/${child.sessionId}/timeline${query({ cursor, direction: "newer" })}`, controller.signal);
      } catch (e) { failure = e; }
      if (controller.signal.aborted) return;
      const decision = decideChildHistory(page, failure);
      if (decision.action === "stop") { setError(decision.message); return; }
      if (decision.action === "resync") { cursor = undefined; setRows([]); }
      if (decision.action === "advance") {
        if (decision.page.after) cursor = decision.page.after;
        setRows((previous) => [...new Map([...previous, ...decision.page.items].map((row) => [row.id, row])).values()].slice(-200));
      }
      timer = setTimeout(() => void poll(), 1200);
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [child.id, child.sessionId]);
  return <aside className="detail-drawer child-drawer" role="dialog" aria-label="子任务详情"><header><strong>子任务 · {child.state}</strong><button aria-label="关闭子任务详情" onClick={close}>×</button></header><pre>{child.summary}</pre>
    {!child.sessionId && <p className="notice">当前运行时只提供子任务状态和用量摘要，未记录可独立读取的子会话历史。</p>}
    {error && <div className="error">{error}</div>}{rows.map((row) => <Markdown key={row.id} text={row.text} />)}
  </aside>;
}
