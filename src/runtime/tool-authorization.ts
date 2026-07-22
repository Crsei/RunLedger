import type {
  ToolAuthorizationDecision,
  ToolAuthorizationPolicy,
  ToolAuthorizationRequest,
} from "./types.ts";

/** 仅供显式测试/兼容 fixture 注入；生产 composition 不得把它设为默认。 */
export class AllowAllToolAuthorizationPolicy implements ToolAuthorizationPolicy {
  authorize(
    _request: ToolAuthorizationRequest,
    _signal?: AbortSignal,
  ): ToolAuthorizationDecision {
    return { decision: "allow" };
  }
}

/**
 * 生产安全基线：没有真实 Gateway/Approval receipt 时拒绝所有工具执行。
 * 只读工具也必须由上层 capability composition 显式授权，不能在此处猜测放行。
 */
export class DenyAllToolAuthorizationPolicy implements ToolAuthorizationPolicy {
  authorize(
    _request: ToolAuthorizationRequest,
    _signal?: AbortSignal,
  ): ToolAuthorizationDecision {
    return {
      decision: "deny",
      reason: "tool execution is unavailable until an authorization policy is explicitly composed",
    };
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
