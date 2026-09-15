import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { builtinHarnessProfiles, harnessProfileDescriptorDigest, projectHarnessTools, resolveHarnessComposition } from "../../../src/runtime/harness-profiles/index.ts";
import { STANDARD_EXECUTION_SYSTEM_PROMPT } from "../../../src/runtime/harness-profiles/standard-prompt.ts";
import { auditHarnessCompositionReceipts, createHarnessCompositionReceipt } from "../../../src/runtime/harness-profiles/composition-receipt.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/resolver.ts";
import { createSessionPlanTools } from "../../../src/runtime/session-runtime/plan-tools.ts";
import type { SessionPlanDomain } from "../../../src/runtime/session-runtime/plan-domain.ts";
import type { AgentTool } from "../../../src/runtime/types.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { productionSessionTools } from "../../../src/runtime/session-runtime/domain.ts";

const PLAN_TOOL_NAMES = ["plan_read", "enter_plan_mode", "exit_plan_mode", "plan_write"];

/** plan 工具的授权入口在 authorization 层，装配时只需要一个可辨识的 domain 引用。 */
const planDomainStub = { inspect: () => { throw new Error("not executed by projection guard"); } } as unknown as SessionPlanDomain;

/** plan@1 的冻结 manifest 覆盖 allowlist 内全部工具，因此必须用真实 governed 工具表。 */
function inertExecutionEnv(cwd: string): ExecutionEnv {
	const unavailable = async (): Promise<never> => { throw new Error("not executed by guard test"); };
	return {
		cwd,
		fs: { readFile: unavailable, writeFile: unavailable, stat: unavailable, readdir: unavailable, mkdir: unavailable, rm: unavailable, rename: unavailable },
		shell: { exec: unavailable },
	};
}

function tool(name: string): AgentTool {
	return {
		name, label: name, description: name,
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() { return { content: [{ type: "text" as const, text: "" }], details: {} }; },
	};
}

function standardDescriptor() {
	return builtinHarnessProfiles().find((profile) => profile.id === "standard" && profile.version === 2)!;
}

function planDescriptor() {
	return builtinHarnessProfiles().find((profile) => profile.id === "plan" && profile.version === 1)!;
}

describe("standard profile plan tool guard", () => {
	it("keeps the standard descriptor digest independent of the governed tool table", () => {
		const descriptor = standardDescriptor();
		const before = harnessProfileDescriptorDigest(descriptor);
		// 描述符已冻结：把 plan 工具加入 governed composition 后 ref 与 digest 不变，
		// 因此不需要新 profile version、schema 迁移或 trigger 白名单更新。
		const planTools = createSessionPlanTools(planDomainStub).tools;
		expect(descriptor.tools.mode).toBe("standard");
		expect(descriptor.tools.allowlist).toEqual([]);
		expect(harnessProfileDescriptorDigest(standardDescriptor()).digest).toBe(before.digest);
		expect(standardHarnessProfileRef(2).descriptorDigest.digest).toBe(before.digest);
		expect(planTools.map((tool) => tool.name)).toEqual(PLAN_TOOL_NAMES);
	});

	it("does not pin a standard tool manifest in the composition receipt audit", () => {
		const planTools = createSessionPlanTools(planDomainStub).tools;
		const baseTools: readonly AgentTool[] = [tool("read")];
		const events = [
			{ sequence: 1, ownerGeneration: 1, eventType: "harness.composed" },
			{ sequence: 2, ownerGeneration: 2, eventType: "harness.composed" },
		];
		const receipts = [
			createHarnessCompositionReceipt({
				sessionId: "session_guard", ownerGeneration: 1, descriptor: standardDescriptor(),
				composition: resolveHarnessComposition({ ref: standardHarnessProfileRef(2), systemPrompt: STANDARD_EXECUTION_SYSTEM_PROMPT, governedTools: baseTools }),
			}),
			createHarnessCompositionReceipt({
				sessionId: "session_guard", ownerGeneration: 2, descriptor: standardDescriptor(),
				composition: resolveHarnessComposition({ ref: standardHarnessProfileRef(2), systemPrompt: STANDARD_EXECUTION_SYSTEM_PROMPT, governedTools: [...baseTools, ...planTools] }),
			}),
		];
		// 旧 receipt（无 plan 工具）与新 receipt（含 plan 工具）都必须通过审计：
		// standard 的 receipt 只做自洽校验，不比对冻结的 tool manifest。
		const audit = auditHarnessCompositionReceipts({
			sessionId: "session_guard",
			profile: standardHarnessProfileRef(2),
			events: events.map((event, index) => ({ ...event, payloadJson: JSON.stringify(receipts[index]) })),
		});
		expect(audit).toMatchObject({ ok: true });
		expect(receipts[0]!.tools.map((tool) => tool.name)).toEqual(["read"]);
		expect(receipts[1]!.tools.map((tool) => tool.name)).toEqual(["read", ...PLAN_TOOL_NAMES]);
		expect(receipts[0]!.toolManifestDigest.digest).not.toBe(receipts[1]!.toolManifestDigest.digest);
	});

	it("leaves the frozen plan@1 manifest byte-identical while plan tools grow", () => {
		const planTools = createSessionPlanTools(planDomainStub).tools;
		const descriptor = planDescriptor();
		const projected = projectHarnessTools(descriptor, [
			...productionSessionTools("/workspace", inertExecutionEnv("/workspace")), ...planTools,
		]);
		// allowlist 只投影 read/glob/ls/plan_read/plan_write；新增的 enter/exit 不进入 plan@1，
		// 且 manifest digest 与冻结值逐字节一致。
		expect(descriptor.tools.allowlist).toEqual(["read", "glob", "ls", "plan_read", "plan_write"]);
		expect(projected.tools.map((tool) => tool.name).sort()).toEqual(["glob", "ls", "plan_read", "plan_write", "read"]);
		expect(projected.tools.map((tool) => tool.name)).not.toContain("enter_plan_mode");
		expect(projected.tools.map((tool) => tool.name)).not.toContain("exit_plan_mode");
		expect(projected.manifestDigest.digest).toBe("7b5b2a3c5e04a75321d057bbdc9dac200dc97878088e62427f49afb1c3640f5e");
	});
});
