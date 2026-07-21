/**
 * WebFetch 工具 —— LLM 主动抓 URL。
 *
 * 对齐 claude-code-bun docs/tools/web-fetch-tool.mdx:
 *   - 输入 url (HTTPS upgrade) + prompt
 *   - 服务端通过 fetch → 转 markdown → 拿到正文后用模型按 prompt 提取
 *   - 失败/超时 → throw,agent-loop 兜底转 isError
 *
 * 本期实现:
 *   - 仅做原生 fetch + 最 trivial 的 markdown 转换(剥 HTML 标签);
 *   - 不在工具里跑 LLM,prompt 直接给到调用方自己决定怎么用。
 *   - 服务端再大消息处理交上限调用方;工具给出 prompt 与 raw-markdown 给调用方。
 *
 * 安全:
 *   - HTTP upgrade to HTTPS
 *   - 跨 host redirect 直接 throw,要求调用方再发(对齐 claude-docs)
 *   - 大响应截断到 maxBytes(默认 2MB)
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";

export const webFetchSchema = Type.Object({
  url: Type.String({ description: "目标 URL;HTTP 自动升级 HTTPS" }),
  prompt: Type.String({ description: "对该 URL 正文要回答的问题" }),
  maxBytes: Type.Optional(
    Type.Number({ description: "正文字节截断上限,默认 2_000_000" }),
  ),
});

export type WebFetchInput = Static<typeof webFetchSchema>;

export interface WebFetchDetails {
  url: string;
  fetchedBytes: number;
  truncated: boolean;
  redirectUrl?: string;
}

const DEFAULT_MAX = 2_000_000;

/** 极简 HTML → 平文:去 tag,decode 几个 entity,其余原样。 */
function htmlToText(html: string): string {
  // 折叠非 <script>/<style> 节省 tokens
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
  s = s.replace(/&nbsp;/g, " ").replace(/"/g, '"').replace(/&#39;/g, "'");
  return s.trim();
}

export function createWebFetchTool(): AgentTool<typeof webFetchSchema, WebFetchDetails> {
  return {
    name: "WebFetch",
    label: "WebFetch",
    description:
      "抓 URL 并按 prompt 给出回复。HTTP 自动升级 HTTPS,跨 host redirect 报错(请重发)。",
    parameters: webFetchSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: WebFetchDetails;
      terminate: false;
    }> {
      const input = params.url;
      if (!input) throw new Error("WebFetch: url 必填");
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        throw new Error(`WebFetch: invalid url ${input}`);
      }
      if (url.protocol === "http:" && url.hostname !== "localhost" && !url.hostname.endsWith(".local")) {
        // 升级 HTTPS
        url = new URL(input.replace(/^http:/i, "https:"));
      }
      const maxBytes = params.maxBytes ?? DEFAULT_MAX;
      const bodyPromise = fetch(url.toString(), {
        redirect: "manual",
        headers: { "user-agent": "RunLedger/0.0.1 (+webfetch)" },
      });
      const r = await bodyPromise;
      if (r.status >= 300 && r.status < 400) {
        // redirect:跨 host 报错
        const loc = r.headers.get("location");
        if (loc) {
          try {
            const locUrl = new URL(loc, url.toString());
            if (locUrl.hostname !== url.hostname) {
              throw new Error(`WebFetch: cross-host redirect ${url.hostname} → ${locUrl.hostname}`);
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith("WebFetch:")) throw e;
            // loc URL 解析失败,继续作为普通 redirect
          }
        }
      }
      const contentType = r.headers.get("content-type") ?? "";
      const buf = await r.arrayBuffer();
      const fetched = Buffer.from(buf);
      const truncated = fetched.length > maxBytes;
      const slice = truncated ? fetched.subarray(0, maxBytes) : fetched;
      let text = slice.toString("utf8");
      if (contentType.includes("html")) {
        text = htmlToText(text);
      }
      const promptSummary = `\n\n[fetched ${fetched.length} bytes${truncated ? ", truncated" : ""}]\n[prompt: ${params.prompt}]`;
      return {
        content: [{ type: "text", text: text + promptSummary }],
        details: {
          url: url.toString(),
          fetchedBytes: fetched.length,
          truncated,
        },
        terminate: false,
      };
    },
  };
}
