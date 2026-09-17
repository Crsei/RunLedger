// Adapted tool-card disclosure/dispatch from oh-my-pi collab-web; see THIRD_PARTY_NOTICES.md.
import { useState } from "react";
import { resolveToolRenderer, type Tool } from "./registry.tsx";
export function ToolView({ tool, onDetail }: { tool: Tool; onDetail: (id: string, inputId?: string) => void }) {
  const [open, setOpen] = useState(false);
  const renderer = resolveToolRenderer(tool.name);
  return <div className={`tv-card ${tool.state === "failed" ? "tv-card--error" : ""}`}>
    <button type="button" className="tv-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={`tv-status status-${tool.state}`}>{tool.state === "succeeded" ? "✓" : tool.state === "failed" ? "!" : "·"}</span>
      <strong className="tv-name">{tool.name}</strong><span className="tv-sum"><renderer.Summary tool={tool} /></span><span>{open ? "−" : "+"}</span>
    </button>
    {open && <div className="tv-body"><renderer.Body tool={tool} />{tool.detailRecordId && <button onClick={() => onDetail(tool.detailRecordId!, tool.inputDetailRecordId)}>完整详情</button>}</div>}
  </div>;
}
