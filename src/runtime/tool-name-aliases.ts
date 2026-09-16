/**
 * 工具名别名 —— 历史/外部调用名到当前工具名的映射。
 *
 * 对齐 oh-my-pi `tools/builtin-names.ts` 的 `LEGACY_BUILTIN_TOOL_NAME_ALIASES`:
 * 别名只在**调用解析**时生效(模型发出的 toolCall.name → 组合里的工具实例),
 * 不额外暴露一个工具条目,也不改变 provider 看到的工具表。
 *
 * 这样 `find` 并入 `glob` 之后,旧会话历史与旧提示词里的 `find` 调用仍能解析到
 * 同一个 glob 工具实例;admission 门禁按对象身份判定,因此别名调用与规范名调用
 * 的授权结果一致。
 */

// 只登记 RunLedger 真实存在过的旧名字。oh-my-pi 另有 `search`→`grep`,但本仓库
// 从未注册过 `search` 工具,登记它只会凭空接受一个无效调用名。
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  find: "glob",
});

/** 把别名解析为规范名;非别名原样返回。 */
export function resolveToolName(name: string): string {
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name;
}

/** 按调用名查找工具:先精确匹配,再按别名解析后匹配规范名。 */
export function findToolByCallName<T extends { readonly name: string }>(
  tools: readonly T[],
  callName: string,
): T | undefined {
  const direct = tools.find((tool) => tool.name === callName);
  if (direct !== undefined) return direct;
  const canonical = resolveToolName(callName);
  return canonical === callName ? undefined : tools.find((tool) => tool.name === canonical);
}
