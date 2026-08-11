import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import type { CapabilityClaim } from "../../src/runtime/protocol/capability.ts";
import type { AgentContext, AgentToolCall, AssistantAgentMessage, ToolAuthorizationRequest } from "../../src/runtime/types.ts";
import type { PlanModeState } from "../../src/runtime/modes/plan/types.ts";
import { echoTool } from "../../src/runtime/tools/echo.ts";
import { createStdlibTools } from "../../src/runtime/tools/index.ts";
import { createRequestPermissionsTool } from "../../src/security/tools/request-permissions.ts";
import { HostGovernedToolAuthorizationPolicy } from "../../src/security/integration/runtime-tool-authorization.ts";

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

function request(tool: typeof echoTool): ToolAuthorizationRequest {
	return {
		assistantMessage: { role: "assistant", content: [], stopReason: "toolUse" } as AssistantAgentMessage,
		toolCall: { type: "toolCall", id: "tool-call-plan", name: tool.name, arguments: {} } as AgentToolCall,
		args: {},
		tool,
		context: { messages: [], tools: [tool] } as AgentContext,
	};
}

describe("Host tool admission in Plan Mode", () => {
	it("admits the governed Skill and request_permissions tool names outside Plan Mode", () => {
		const policy = new HostGovernedToolAuthorizationPolicy();
		const skill = createStdlibTools("/tmp/runledger-plan-policy").get("Skill")!;
		const requestPermissions = createRequestPermissionsTool();
		expect(policy.authorize(request(skill))).toEqual({ decision: "allow" });
		expect(policy.authorize(request(requestPermissions))).toEqual({ decision: "allow" });
	});

	it("preserves a restrictive Security decision when Plan Mode is inactive", () => {
		const basePolicy = {
			authorize: () => ({ decision: "deny" as const, reason: "security policy denied" }),
		};
		const policy = new HostGovernedToolAuthorizationPolicy({ basePolicy, planState: () => undefined });
		expect(policy.authorize(request(echoTool))).toEqual({ decision: "deny", reason: "security policy denied" });
	});

	it("does not let Plan Mode replace a restrictive Security decision", () => {
		const basePolicy = {
			authorize: () => ({ decision: "deny" as const, reason: "security policy denied" }),
		};
		const policy = new HostGovernedToolAuthorizationPolicy({ basePolicy, planState: () => activeState });
		expect(policy.authorize(request(echoTool))).toEqual({ decision: "deny", reason: "security policy denied" });
	});

	it("denies a write-capability tool before execute even when it is in the Host registry", () => {
		const tool = { ...echoTool, name: "write", capabilityClaims: [claim("workspace_write", "filesystem")] };
		const policy = new HostGovernedToolAuthorizationPolicy({ planState: () => activeState });
		expect(policy.authorize(request(tool))).toMatchObject({ decision: "deny", reason: expect.stringContaining("plan_mode_write_denied") });
	});

	it("denies an unclaimed tool effect in Plan Mode", () => {
		const policy = new HostGovernedToolAuthorizationPolicy({ planState: () => activeState });
		expect(policy.authorize(request(echoTool))).toMatchObject({ decision: "deny", reason: expect.stringContaining("plan_mode_unknown_effect") });
	});

	it("publishes explicit Runtime capability claims for builtin tools", () => {
		const tools = createStdlibTools("/tmp/runledger-plan-policy");
		expect(tools.get("read")?.capabilityClaims?.map((item) => item.name)).toEqual(["repository_read"]);
		expect(tools.get("write")?.capabilityClaims?.map((item) => item.name)).toEqual(["workspace_write"]);
		expect(tools.get("bash")?.capabilityClaims?.map((item) => item.name)).toEqual(["process"]);
		expect(tools.get("WebFetch")?.capabilityClaims?.map((item) => item.name)).toEqual(["network"]);
	});
});
