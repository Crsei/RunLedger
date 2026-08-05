/**
 * Skill 工具 —— 渐进披露：模型只看到 catalog 元数据，显式调用时按需加载正文。
 *
 * 与 claude-code-bun docs/tools/skill-tool.mdx 对齐:
 *   - 模型通过 `Skill` 工具按 qualifiedId 读取 SKILL.md 正文
 *   - 正文读取不授予脚本执行权限;assets/script 仍需独立 approval
 *   - loader 由 Host 注入(SkillToolResolver 包装 trust + digest 复核),
 *     本工具不直接访问 fs/trust store
 *
 * 低层占位语义(无 loader 时):透传注入的 handlers,供测试与桥接前使用。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";

export const skillSchema = Type.Object({
  name: Type.String({ description: "skill qualifiedId;对应 catalog 中 frontmatter.name 或 identity.qualifiedId" }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type SkillInput = Static<typeof skillSchema>;

export interface SkillDetails {
  matched: boolean;
  /** 加载失败时的 typed code（not_found/ambiguous/invalid/blocked/stale）。 */
  code?: string;
  message?: string;
  /** loader 返回的正文长度（字符）。 */
  bodyLength?: number;
  /** 加载正文后收窄的 allowedTools；未命中时 undefined。 */
  allowedTools?: readonly string[];
}

export type SkillHandler = (
  args: Static<typeof skillSchema>["args"],
) => Promise<unknown> | unknown;

export type SkillLoadResult =
  | { readonly ok: true; readonly body: string; readonly allowedTools?: readonly string[] }
  | { readonly ok: false; readonly code: "not_found" | "ambiguous" | "invalid" | "blocked" | "stale"; readonly message: string };

export type SkillLoader = (name: string, args?: Static<typeof skillSchema>["args"]) => Promise<SkillLoadResult>;

export interface SkillToolOptions {
  /** 真实 catalog loader（Host 注入）；缺省时回退到 handlers 占位语义。 */
  loader?: SkillLoader;
  handlers?: Record<string, SkillHandler>;
}

export function createSkillTool(options: SkillToolOptions = {}): AgentTool<typeof skillSchema, SkillDetails> {
  return {
    name: "Skill",
    label: "Skill",
    description:
      "读取一个已发现 skill 的 SKILL.md 正文。未调用时只有 catalog 元数据进入上下文。",
    parameters: skillSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async execute(_tc, params): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: SkillDetails;
      terminate: false;
    }> {
      const name = params.name;
      if (options.loader !== undefined) {
        const loaded = await options.loader(name, params.args);
        if (!loaded.ok) {
          return {
            content: [{ type: "text", text: `Skill unavailable: ${loaded.message}` }],
            details: { matched: false, code: loaded.code, message: loaded.message },
            terminate: false,
          };
        }
        return {
          content: [{ type: "text", text: loaded.body }],
          details: { matched: true, bodyLength: loaded.body.length, ...(loaded.allowedTools === undefined ? {} : { allowedTools: loaded.allowedTools }) },
          terminate: false,
        };
      }
      const handler = options.handlers?.[name];
      if (!handler) {
        return {
          content: [{ type: "text", text: `Skill not registered: ${name}` }],
          details: { matched: false, message: "skill not registered" },
          terminate: false,
        };
      }
      const out = await handler(params.args);
      return {
        content: [
          { type: "text", text: typeof out === "string" ? out : JSON.stringify(out ?? "(no result)") },
        ],
        details: { matched: true, bodyLength: typeof out === "string" ? out.length : 0 },
        terminate: false,
      };
    },
  };
}
