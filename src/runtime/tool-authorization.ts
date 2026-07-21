import type {
  ToolAuthorizationDecision,
  ToolAuthorizationPolicy,
  ToolAuthorizationRequest,
} from "./types.ts";

/** 第一版默认策略:所有已注册工具自动执行。 */
export class AllowAllToolAuthorizationPolicy implements ToolAuthorizationPolicy {
  authorize(
    _request: ToolAuthorizationRequest,
    _signal?: AbortSignal,
  ): ToolAuthorizationDecision {
    return { decision: "allow" };
  }
}

/** 把权限策略适配成 agent-loop 已有的 beforeToolCall hook。 */
export function authorizationBeforeToolCall(
  policy: ToolAuthorizationPolicy,
): (
  request: ToolAuthorizationRequest,
  signal?: AbortSignal,
) => Promise<{ block?: boolean; reason?: string } | undefined> {
  return async (request, signal) => {
    const decision = await policy.authorize(request, signal);
    if (decision.decision === "allow") return undefined;
    return { block: true, reason: decision.reason };
  };
}
