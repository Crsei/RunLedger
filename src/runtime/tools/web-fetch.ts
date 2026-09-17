/**
 * WebFetch 工具 —— LLM 主动抓 URL。
 *
 * 对齐 claude-code-bun docs/tools/web-fetch-tool.mdx:
 *   - 输入 url (HTTPS upgrade) + prompt
 *   - 抓取 → 站点特化提取或 HTML→Markdown → 得到正文后交给调用方按 prompt 使用
 *   - 失败/超时 → throw,agent-loop 兜底转 isError
 *
 * 抓取管线（对齐 oh-my-pi `tools/fetch.ts` 的 renderUrl 前两步）:
 *   1. 顺序尝试站点特化 handler（github/npm/pypi/arxiv/… 共 74 个），首个命中即返回；
 *   2. 未命中则通用抓取 + charset 解码 + Turndown(GFM) 转 Markdown。
 *
 * 安全:
 *   - HTTP upgrade to HTTPS
 *   - 出站一律经受治 `Network` port（`createWebSearchFetch`），重定向由该层处理并
 *     拒绝跨 host/port 跳转
 *   - 大响应截断到 maxBytes(默认 2MB)
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { localNetwork } from "./local-defaults.ts";
import type { Network } from "../execution-env.ts";
import type { AgentTool } from "../types.ts";
import {
  unavailableWebSearchCredentials,
  type WebSearchCredentialPort,
} from "../../websource/credentials.ts";
import type { WebSearchSettings } from "../../websource/settings.ts";
import { createWebSearchFetch, WebSourceNetworkError } from "../../websource/transport.ts";
import type { RenderResult, ScraperContext } from "../../websource/scrapers/types.ts";
import { htmlToBasicMarkdown, loadPage } from "../../websource/scrapers/types.ts";
import { handleSpecialUrls } from "../../websource/scrapers/dispatch.ts";

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
  /** 产生正文的方式:`<handler>` 为站点特化提取,其余是通用管线。 */
  method?: string;
}

const DEFAULT_MAX = 2_000_000;
/** 站点 handler 的超时（秒）；与上游 fetch 工具的默认预算一致。 */
const HANDLER_TIMEOUT_SECONDS = 20;

export interface WebFetchToolOptions {
  readonly network?: Network;
  /** 站点 handler 需要的凭据（例如 GitHub API token）；缺省视为无凭据。 */
  readonly credentials?: WebSearchCredentialPort;
  readonly settings?: WebSearchSettings;
}

export function createWebFetchTool(options: WebFetchToolOptions = {}): AgentTool<typeof webFetchSchema, WebFetchDetails> {
	const network = options.network ?? localNetwork();
	const fetch = createWebSearchFetch({ network, principal: "WebFetch" });
	const context: ScraperContext = {
		fetch,
		credentials: options.credentials ?? unavailableWebSearchCredentials(),
		...(options.settings === undefined ? {} : { settings: options.settings }),
	};
  return {
    name: "WebFetch",
    label: "WebFetch",
    description:
      "抓 URL 并按 prompt 给出回复。HTTP 自动升级 HTTPS,跨 host redirect 报错(请重发)。",
    parameters: webFetchSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
	async execute(_toolCallId, params, signal): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: WebFetchDetails;

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
      const target = url.toString();

      let rendered: RenderResult | undefined;
      try {
        rendered = await handleSpecialUrls(target, HANDLER_TIMEOUT_SECONDS, context, signal) ?? undefined;
      } catch (error) {
        throw toWebFetchError(error);
      }

      if (rendered === undefined) {
        const page = await loadPage(context, target, {
          timeout: HANDLER_TIMEOUT_SECONDS,
          ...(signal === undefined ? {} : { signal }),
        }).catch((error: unknown) => {
          throw toWebFetchError(error);
        });
        if (!page.ok) {
          // loadPage 把传输层错误降级成字符串,因此这里也要剥掉来源前缀,
          // 让对外文案与跨站重定向一致(调用方按 `WebFetch: ...` 解析)。
          const detail = stripSourcePrefix(page.error ?? `HTTP ${page.status ?? "error"}`);
          throw new Error(`WebFetch: ${detail} for ${target}`);
        }
        const body = page.contentType.includes("html") || page.contentType === ""
          ? await htmlToBasicMarkdown(page.content)
          : page.content;
        rendered = {
          url: target,
          finalUrl: page.finalUrl,
          contentType: page.contentType,
          method: page.contentType.includes("html") ? "markdown" : "text",
          content: body,
          fetchedAt: new Date().toISOString(),
          truncated: page.truncated === true,
          notes: [],
        };
      }

      const fetched = Buffer.from(rendered.content, "utf8");
      const truncated = fetched.byteLength > maxBytes;
      const slice = truncated ? fetched.subarray(0, maxBytes) : fetched;
      const text = slice.toString("utf8");
      const promptSummary = `\n\n[fetched ${fetched.byteLength} bytes via ${rendered.method}${truncated ? ", truncated" : ""}]\n[prompt: ${params.prompt}]`;
      return {
        content: [{ type: "text", text: text + promptSummary }],
        details: {
          url: target,
          fetchedBytes: fetched.byteLength,
          truncated,
          method: rendered.method,
        },
      };
    },
  };
}

/**
 * 把传输层的跨站重定向拒绝还原成 WebFetch 的既有错误文案。
 *
 * 该错误的语义（fail closed、要求调用方重发）没变,只是产生它的层从工具本体
 * 移到了受治传输层;对外文案保持一致,避免调用方/测试依赖的契约漂移。
 */
function toWebFetchError(error: unknown): unknown {
	if (error instanceof WebSourceNetworkError) return new Error(`WebFetch: ${stripSourcePrefix(error.message)}`);
	return error;
}

function stripSourcePrefix(message: string): string {
	return message.replace(/^websource: /, "");
}
