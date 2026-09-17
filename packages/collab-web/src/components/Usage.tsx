import { useEffect, useState } from "react";
import type { WebUsage } from "../contracts/index.ts";
import { get, query, errorText } from "../lib/api.ts";

function quantity(value: WebUsage["inputTokens"], cost = false): string {
  const format = (number: number) => cost ? `$${number.toFixed(5)}` : number.toLocaleString();
  const parts = [value.exact === null ? "" : format(value.exact), value.estimated === null ? "" : `估算 ${format(value.estimated)}`].filter(Boolean);
  return parts.join(" + ") || "未知";
}
export function Usage({ project, timeFrom }: { project: string; timeFrom: number }) {
  const [value, setValue] = useState<WebUsage | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!project) return;
    setValue(null); setError("");
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await get<WebUsage>(`/api/v1/projects/${project}/usage${query({ timeFrom, timeTo: Date.now() })}`, controller.signal);
        if (!controller.signal.aborted) { setValue(result); setError(""); }
      } catch (e) { if (!controller.signal.aborted) setError(errorText(e)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), document.hidden ? 10000 : 2000);
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [project, timeFrom]);
  return <section className="usage-panel" aria-label="项目模型用量"><div className="section-title"><h3>模型用量</h3><span className="muted">{value ? value.coverage === "complete" ? "已完成对账" : "部分数据 · 扫描中或记录缺失" : "读取中"}</span></div>
    {error && <div className="error">{error}</div>}
    <div className="usage-grid">{value && ([ ["实际调用", value.uniqueCalls.toLocaleString()], ["输入 token", quantity(value.inputTokens)], ["输出 token", quantity(value.outputTokens)], ["缓存读取 / 写入", `${quantity(value.cacheReadTokens)} / ${quantity(value.cacheWriteTokens)}`], ["费用", quantity(value.costUsd, true)] ]).map(([label, text]) => <div key={label}><small>{label}</small><strong>{text}</strong></div>)}</div>
    {value && <p className="muted">来源：{value.sources.join(" / ") || "未记录"}；{value.costUsd.missingCalls} 次调用费用未知；{value.excludedUnidentifiedObservations} 条历史记录因调用身份不明未计入。更新于 {new Date(value.asOfMs).toLocaleTimeString()}。</p>}
  </section>;
}
