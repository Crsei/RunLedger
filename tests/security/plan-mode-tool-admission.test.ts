import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import type { CapabilityClaim } from "../../src/runtime/protocol/capability.ts";
import type { AgentContext, AgentTool, AgentToolCall, AssistantAgentMessage, ToolAuthorizationRequest } from "../../src/runtime/types.ts";
import type { PlanModeState } from "../../src/runtime/modes/plan/types.ts";
import { echoTool } from "../../src/runtime/tools/echo.ts";
import { createStdlibTools } from "../../src/runtime/tools/index.ts";
import type { ExecutionEnv } from "../../src/runtime/execution-env.ts";
import { unavailableWebSearchCredentials } from "../../src/websource/credentials.ts";
import { createRequestPermissionsTool } from "../../src/security/tools/request-permissions.ts";
import { HostGovernedToolAuthorizationPolicy } from "../../src/security/integration/runtime-tool-authorization.ts";
import { createSpawnAgentTool } from "../../src/runtime/agents/spawn-tool.ts";
import { MULTI_AGENT_HARD_LIMITS } from "../../src/runtime/agents/limits.ts";
import { createLspTool } from "../../src/lsp/tool.ts";

const sessionId = createRuntimeId("session", "plan-tool-admission");
const activeState: PlanModeState = {
	status: "active",
	sessionId,
	goalId: createRuntimeId("goal", "plan-tool-admission"),
	revision: 4,
	plan: {
		goalId: createRuntimeId("goal", "plan-tool-admission"),
		workspaceId: createRuntimeId("workspace", "plan-tool-admission"),
		revision: 0,
		digest: runtimeDigest("plan"),
		artifactRef: { subjectKind: "artifact", digest: runtimeDigest("plan"), mediaType: "text/markdown", size: 4 },
	},
	policyCeilingDigest: runtimeDigest("policy"),
	sourceHead: { streamId: sessionId, sequence: 1, eventHash: runtimeDigest("head") },
	projectionDigest: runtimeDigest("projection"),
	completeness: "complete",
	updatedAt: "2026-08-05T00:00:00.000Z",
};

function claim(name: CapabilityClaim["name"], resourceKind: CapabilityClaim["resourceKind"]): CapabilityClaim {
	return { name, resourceKind, resourceDigest: runtimeDigest(name), constraintsDigest: runtimeDigest(resourceKind), scope: "invocation" };
}

function request(tool: AgentTool): ToolAuthorizationRequest {
	return {
		assistantMessage: { role: "assistant", content: [], stopReason: "toolUse" } as AssistantAgentMessage,
		toolCall: { type: "toolCall", id: "tool-call-plan", name: tool.name, arguments: {} } as AgentToolCall,
		args: {},
		tool,
		context: { messages: [], tools: [tool] } as AgentContext,
	};
}

/**
 * 复制一个工具并改名(可附带 claims)。先把实例放宽到 `AgentTool`,否则
 * 具体泛型的 `execute` 签名无法赋给默认类型参数。
 */
function renameTool(tool: AgentTool, name: string, capabilityClaims?: readonly CapabilityClaim[]): AgentTool {
	return { ...tool, name, ...(capabilityClaims === undefined ? {} : { capabilityClaims }) };
}

/** 生产 composition 会组合出的、非 stdlib 来源的 Session-owned 工具。 */
function sessionOwnedTools(): readonly AgentTool[] {
	return [
		createSpawnAgentTool({
			domain: { spawn: async () => ({ ok: false as const, error: { code: "runtime_unavailable" as const, message: "fixture" } }) },
			policy: { enabled: true, limits: MULTI_AGENT_HARD_LIMITS },
			sessionId,
			rootAgentId: createRuntimeId("agent", "plan-tool-admission-root"),
			ownerGeneration: 1,
		}),
	];
}

/** 只用于装配期判定:任何真实调用都会抛出。 */
function inertExecutionEnv(cwd: string): ExecutionEnv {
	const unavailable = async (): Promise<never> => { throw new Error("not executed by admission test"); };
	return {
		cwd,
		fs: { readFile: unavailable, writeFile: unavailable, stat: unavailable, readdir: unavailable, mkdir: unavailable, rm: unavailable, rename: unavailable },
		shell: { exec: unavailable },
	};
}

describe("governed tool admission", () => {
	it("admits every tool the Session composition actually exposes", () => {
		const registry = createStdlibTools("/tmp/runledger-plan-policy");
		const composed = [...registry.toContext(), createRequestPermissionsTool(), ...sessionOwnedTools()];
		const policy = new HostGovernedToolAuthorizationPolicy({ admittedTools: () => composed });
		for (const tool of composed) {
			expect(policy.authorize(request(tool)), `${tool.name} must be admitted`).toEqual({ decision: "allow" });
		}
		// 名单式实现曾漏掉这些工具名并静默拒绝;逐个点名以防回归。
		expect(composed.map((tool) => tool.name)).toEqual(expect.arrayContaining([
			"Skill", "request_permissions", "spawn_agent",
		]));
	});

	it("admits tools appended after policy construction", () => {
		const composed: AgentTool[] = [...createStdlibTools("/tmp/runledger-plan-policy").toContext()];
		const policy = new HostGovernedToolAuthorizationPolicy({ admittedTools: () => composed });
		const [spawn] = sessionOwnedTools();
		composed.push(spawn!);
		expect(policy.authorize(request(spawn!))).toEqual({ decision: "allow" });
	});

	it("denies a tool that is not part of the composed set", () => {
		const registry = createStdlibTools("/tmp/runledger-plan-policy");
		const policy = new HostGovernedToolAuthorizationPolicy({ admittedTools: () => registry.toContext() });
		const foreign = renameTool(echoTool, "not_composed");
		expect(policy.authorize(request(foreign))).toMatchObject({
			decision: "deny",
			reason: expect.stringContaining("not admitted by the governed composition"),
		});
	});

	it("admits the governed lsp tool outside Plan Mode", () => {
		const lsp = createLspTool("/tmp/runledger-plan-policy", { getConfig: () => ({ servers: {} }) });
		const policy = new HostGovernedToolAuthorizationPolicy({ admittedTools: () => [lsp] });
		expect(policy.authorize(request(lsp))).toEqual({ decision: "allow" });
	});

	it("preserves a restrictive Security decision when Plan Mode is inactive", () => {
		const basePolicy = {
			authorize: () => ({ decision: "deny" as const, reason: "security policy denied" }),
		};
		const policy = new HostGovernedToolAuthorizationPolicy({ basePolicy, planState: () => undefined, admittedTools: () => [echoTool] });
		expect(policy.authorize(request(echoTool))).toEqual({ decision: "deny", reason: "security policy denied" });
	});

	it("does not let Plan Mode replace a restrictive Security decision", () => {
		const basePolicy = {
			authorize: () => ({ decision: "deny" as const, reason: "security policy denied" }),
		};
		const policy = new HostGovernedToolAuthorizationPolicy({ basePolicy, planState: () => activeState, admittedTools: () => [echoTool] });
		expect(policy.authorize(request(echoTool))).toEqual({ decision: "deny", reason: "security policy denied" });
	});

	it("denies a write-capability tool before execute even when it is in the Host registry", () => {
		const tool = renameTool(echoTool, "write", [claim("workspace_write", "filesystem")]);
		const policy = new HostGovernedToolAuthorizationPolicy({ planState: () => activeState, admittedTools: () => [tool] });
		expect(policy.authorize(request(tool))).toMatchObject({ decision: "deny", reason: expect.stringContaining("plan_mode_write_denied") });
	});

	it("denies an unclaimed tool effect in Plan Mode", () => {
		const policy = new HostGovernedToolAuthorizationPolicy({ planState: () => activeState, admittedTools: () => [echoTool] });
		expect(policy.authorize(request(echoTool))).toMatchObject({ decision: "deny", reason: expect.stringContaining("plan_mode_unknown_effect") });
	});

	it("publishes explicit Runtime capability claims for builtin tools", () => {
		// web_search 与 WebFetch 同样在注入 ExecutionEnv 时才注册,因此这里按生产
		// 装配方式构造。
		const tools = createStdlibTools("/tmp/runledger-plan-policy", {
			executionEnv: inertExecutionEnv("/tmp/runledger-plan-policy"),
			webSearch: { credentials: unavailableWebSearchCredentials() },
		});
		expect(tools.get("read")?.capabilityClaims?.map((item) => item.name)).toEqual(["repository_read"]);
		expect(tools.get("write")?.capabilityClaims?.map((item) => item.name)).toEqual(["workspace_write"]);
		expect(tools.get("bash")?.capabilityClaims?.map((item) => item.name)).toEqual(["process"]);
		expect(tools.get("WebFetch")?.capabilityClaims?.map((item) => item.name)).toEqual(["network"]);
		expect(tools.get("web_search")?.capabilityClaims?.map((item) => item.name)).toEqual(["network"]);
	});
});
