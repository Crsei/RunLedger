/**
 * Skill 工具占位 —— V2 的"调一个 handler/skill"。
 *
 * 与 claude-code-bun docs/tools/skill-tool.mdx 区别:
 *   - claude 的 Skill 是文件级 plugin/manifest 体系(目录 skill.md + scripts)
 *   - 本期 V2 先做"占位工具":通过 handler registry 转发到调用方注入的回调。
 *
 * 占位语义:
 *   - execute 仅查找 options.handlers[name];若不存在,return text "skill not registered"。
 *   - 输入 args 与 schema 都透传给 handler。
 *   - 本期不实现 plugin manifest / 加载 / 资源生命周期。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";

export const skillSchema = Type.Object({
  name: Type.String({ description: "skill 名;对应 createSkillTool({ handlers }) 中的 key" }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type SkillInput = Static<typeof skillSchema>;

export interface SkillDetails {
  matched: boolean;
  handlerReturned?: unknown;
}

export type SkillHandler = (
  args: Static<typeof skillSchema>["args"],
) => Promise<unknown> | unknown;

export interface SkillToolOptions {
  handlers?: Record<string, SkillHandler>;
}

export function createSkillTool(options: SkillToolOptions = {}): AgentTool<typeof skillSchema, SkillDetails> {
  return {
    name: "Skill",
    label: "Skill",
    description:
      "调用一个已注册 skill handler。本期 V2 占位:不支持 manifest 加载,仅转发到注入的 handlers。",
    parameters: skillSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(_tc, params): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: SkillDetails;
      terminate: false;
    }> {
      const name = params.name;
      const handler = options.handlers?.[name];
      if (!handler) {
        return {
          content: [{ type: "text", text: `Skill not registered: ${name}` }],
          details: { matched: false },
          terminate: false,
        };
      }
      const out = await handler(params.args);
      return {
        content: [
          { type: "text", text: typeof out === "string" ? out : JSON.stringify(out ?? "(no result)") },
        ],
        details: { matched: true, handlerReturned: out },
        terminate: false,
      };
    },
  };
}
