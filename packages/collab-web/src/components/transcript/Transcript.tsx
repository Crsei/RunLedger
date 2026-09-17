// Adapted from oh-my-pi collab-web Transcript; see THIRD_PARTY_NOTICES.md.
import type { ReactNode } from "react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WebTimelineRow } from "../../contracts/index.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolView } from "../../tool-render/ToolView.tsx";

interface ScrollGeometry { scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number }
interface TailLock { current: boolean }
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
  if (force) lock.current = true;
  if (lock.current) element.scrollTop = element.scrollHeight;
}
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
  lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}
function Row({ kind, gutter, children }: { kind: string; gutter: ReactNode; children: ReactNode }): ReactNode {
  return <div className={`tr-row tr-row--${kind}`}><div className="tr-gutter">{gutter}</div><div className="tr-body">{children}</div></div>;
}
function ThinkingBlock({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return <div className="tr-think"><button type="button" className="tr-think-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "▾" : "▸"} 思考过程</button>{open && <div className="tr-think-body">{text}</div>}</div>;
}
const MeasuredRow = memo(function MeasuredRow({ row, measure, onDetail }: { row: WebTimelineRow; measure: (id: string, height: number) => void; onDetail: (id: string, inputId?: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => measure(row.id, element.getBoundingClientRect().height));
    observer.observe(element); return () => observer.disconnect();
  }, [row.id, measure]);
  return <div ref={ref} data-row-id={row.id} className="measured-row">
    {row.tool ? <ToolView tool={row.tool} onDetail={onDetail} /> : <Row kind={row.kind} gutter={row.kind === "user" ? "你" : row.kind === "assistant" ? "RL" : "·"}>
      {row.kind === "thinking" ? <ThinkingBlock text={row.text} /> : <Markdown text={row.text} />}
      {row.truncated && <small className="muted">正文已截断。{row.detailRecordId && <button onClick={() => onDetail(row.detailRecordId!)}>完整正文</button>}</small>}
    </Row>}
  </div>;
});
export function Transcript({ rows: sourceRows, before, loading, paused, pause, older, latest, onDetail }: {
  rows: readonly WebTimelineRow[]; before: string | null; loading: boolean;
  paused: boolean; pause: () => void; older: () => void; latest: () => void; onDetail: (id: string, inputId?: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null), lock = useRef(true);
  const programmatic = useRef(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 700 });
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [following, setFollowing] = useState(true);
  const measure = useCallback((id: string, height: number) => setHeights((previous) => {
    if (Math.abs((previous.get(id) ?? 0) - height) < 1) return previous;
    const next = new Map(previous); next.set(id, height);
    if (next.size > 2200) next.delete(next.keys().next().value!);
    return next;
  }), []);
  const rows = useMemo(() => {
    const result: WebTimelineRow[] = [], toolIndices = new Map<string, number>();
    for (const row of sourceRows) {
      const previous = row.tool ? toolIndices.get(row.tool.callId) : undefined;
      if (previous !== undefined && row.tool) {
        const prior = result[previous];
        result[previous] = { ...prior, tool: { ...row.tool, inputPreview: prior.tool?.inputPreview || row.tool.inputPreview, inputDetailRecordId: prior.tool?.inputDetailRecordId ?? row.tool.inputDetailRecordId } };
      } else { if (row.tool) toolIndices.set(row.tool.callId, result.length); result.push(row); }
    }
    return result;
  }, [sourceRows]);
  const offsets = useMemo(() => { const result = [0]; for (const row of rows) result.push(result.at(-1)! + (heights.get(row.id) ?? (row.kind === "tool" ? 64 : 150))); return result; }, [rows, heights]);
  const find = (top: number) => Math.max(0, offsets.findIndex((offset, index) => index < rows.length && offsets[index + 1] > top));
  const start = Math.max(0, find(Math.max(0, viewport.top - 64)) - 6), end = Math.min(rows.length, Math.max(start + 30, find(viewport.top + viewport.height) + 8));
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    programmatic.current = true;
    if (lock.current) followTranscriptTail(element, lock);
    else if (anchor.current) {
      const index = rows.findIndex((row) => row.id === anchor.current!.id);
      if (index >= 0) element.scrollTop = 64 + offsets[index] + anchor.current.offset;
    }
    setViewport({ top: element.scrollTop, height: element.clientHeight });
  }, [rows, offsets]);
  return <div className="transcript-wrap">
    <div ref={scroller} className="transcript" data-testid="transcript" onWheel={() => { programmatic.current = false; }} onPointerDown={() => { programmatic.current = false; }} onTouchMove={() => { programmatic.current = false; }} onKeyDown={() => { programmatic.current = false; }} onScroll={(event) => {
      const element = event.currentTarget;
      if (!programmatic.current) {
        updateTranscriptTailLock(element, lock); setFollowing(lock.current); if (!lock.current) pause();
        const top = element.getBoundingClientRect().top;
        const first = [...element.querySelectorAll<HTMLElement>("[data-row-id]")].find((row) => row.getBoundingClientRect().bottom > top);
        anchor.current = first ? { id: first.dataset.rowId!, offset: top - first.getBoundingClientRect().top } : null;
      }
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    }}>
      <div className="history-load">{before ? <button disabled={loading} onClick={() => {
        const element = scroller.current;
        if (element) {
          const top = element.getBoundingClientRect().top;
          const first = [...element.querySelectorAll<HTMLElement>("[data-row-id]")].find((row) => row.getBoundingClientRect().bottom > top);
          anchor.current = first ? { id: first.dataset.rowId!, offset: top - first.getBoundingClientRect().top } : null;
        }
        lock.current = false; older();
      }}>{loading ? "读取中…" : "↑ 加载更早记录"}</button> : <span>会话起点</span>}</div>
      <div style={{ height: offsets[start] }} aria-hidden="true" />
      {rows.slice(start, end).map((row) => <MeasuredRow key={row.id} row={row} measure={measure} onDetail={onDetail} />)}
      <div style={{ height: offsets.at(-1)! - offsets[end] }} aria-hidden="true" />
      {!rows.length && <div className="empty">{loading ? "正在读取会话…" : "该会话尚无已提交的对话"}</div>}
    </div>
    {(!following || paused) && <button className="jump-latest" onClick={() => { lock.current = true; setFollowing(true); latest(); }}>↓ 回到最新</button>}
  </div>;
}
