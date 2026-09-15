/** Plan 工具仅调用 Session-owned authority，不接受文件路径或直接写文件。 */
import { Type } from "typebox";
import type { Static } from "typebox";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { AgentTool } from "../types.ts";
import type { PlanModeStatus } from "../modes/plan/types.ts";
import type { SessionPlanDomain } from "./plan-domain.ts";

const PLAN_ARTIFACT_CLAIM = {
	name: "workspace_write" as const,
	resourceKind: "filesystem" as const,
	resourceDigest: runtimeDigest("session-plan-artifact"),
	constraintsDigest: runtimeDigest("plan-artifact-only"),
	scope: "invocation" as const,
};

/** 状态变更型 plan 工具及其生效状态；由 composition 按实例身份注入 authorization。 */
export interface PlanArtifactWriteGate {
	readonly tool: AgentTool;
	/** 该工具在当前 mode 状态下是否生效。 */
	readonly allows: (status: PlanModeStatus) => boolean;
}

export interface SessionPlanTools {
	readonly tools: readonly AgentTool[];
	readonly writeGates: readonly PlanArtifactWriteGate[];
}

const revisionSchema = Type.Object({
	expectedRevision: Type.Integer({ minimum: 0, description: "State revision from plan_read" }),
}, { additionalProperties: false });
const writeSchema = Type.Object({
	expectedRevision: Type.Integer({ minimum: 0, description: "State revision from plan_read" }),
	expectedPlanRevision: Type.Integer({ minimum: 0, description: "Artifact revision from plan_read" }),
	content: Type.String({ minLength: 1, maxLength: 65_536, description: "Complete Markdown plan body; no path or patch" }),
}, { additionalProperties: false });

type RevisionInput = Static<typeof revisionSchema>;
type WriteInput = Static<typeof writeSchema>;

export function createSessionPlanTools(domain: SessionPlanDomain): SessionPlanTools {
	const mutate = async (operation: string, toolCallId: string, input: Record<string, unknown>) => {
		const result = await domain.mutate(operation, input, {
			expectedRevision: input.expectedRevision as number,
			correlationId: toolCallId,
			effectId: toolCallId,
		});
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result.ok ? result.value : { code: result.code }) }],
			details: {},
			...(result.ok ? {} : { isError: true }),
		};
	};

	// plan_read / plan_write 的描述与 schema 属于冻结的 plan@1 manifest，不得改写。
	const read: AgentTool = {
		name: "plan_read", label: "Read plan",
		description: "Read the current plan artifact, state revision, artifact revision and approval status.",
		parameters: Type.Object({}, { additionalProperties: false }),
		capabilityClaims: [{ name: "repository_read", resourceKind: "filesystem", resourceDigest: runtimeDigest("session-plan-artifact"), constraintsDigest: runtimeDigest("read-only"), scope: "invocation" }],
		isReadOnly: () => true, isConcurrencySafe: () => true,
		async execute() {
			try {
				return { content: [{ type: "text", text: JSON.stringify(domain.inspect()) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
			}
		},
	};
	const write: AgentTool<typeof writeSchema> = {
		name: "plan_write", label: "Write plan",
		description: "Replace only the current plan artifact with a new immutable revision. Cannot modify workspace files or approve a plan.",
		parameters: writeSchema,
		capabilityClaims: [PLAN_ARTIFACT_CLAIM],
		isReadOnly: () => false, isConcurrencySafe: () => false,
		execute: (toolCallId: string, input: WriteInput) => mutate("plan.write", toolCallId, input),
	};

	const enter: AgentTool<typeof revisionSchema> = {
		name: "enter_plan_mode", label: "Request plan mode",
		description: "Ask the user to switch this session into read-only plan mode so you can explore and maintain a versioned plan artifact before changing the workspace. The request stays pending until the user approves it in the UI/CLI; nothing changes and no permission is granted before that.",
		parameters: revisionSchema,
		capabilityClaims: [PLAN_ARTIFACT_CLAIM],
		isReadOnly: () => false, isConcurrencySafe: () => false,
		execute: (toolCallId: string, input: RevisionInput) => mutate("plan.enter", toolCallId, { ...input, requestedBy: "agent" }),
	};
	const exit: AgentTool<typeof revisionSchema> = {
		name: "exit_plan_mode", label: "Submit plan for approval",
		description: "Submit the current plan artifact for approval. Pins the state revision, artifact revision and digest the reviewer sees; the model cannot choose a revision and cannot approve its own plan.",
		parameters: revisionSchema,
		capabilityClaims: [PLAN_ARTIFACT_CLAIM],
		isReadOnly: () => false, isConcurrencySafe: () => false,
		async execute(toolCallId: string, input: RevisionInput) {
			const state = domain.inspect().state;
			if (state.plan === undefined) {
				return { content: [{ type: "text" as const, text: JSON.stringify({ code: "plan_artifact_required" }) }], details: {}, isError: true };
			}
			return mutate("plan.request_approval", toolCallId, {
				expectedRevision: input.expectedRevision,
				expectedPlanRevision: state.plan.revision,
				expectedPlanDigest: state.plan.digest,
			});
		},
	};

	return {
		tools: [read, enter, exit, write],
		writeGates: [
			// 用户侧 plan.activate 交付 pending；模型不得在自己的 pending 上写工件。
			{ tool: enter, allows: (status) => status === "inactive" },
			{ tool: write, allows: (status) => status === "active" },
			{ tool: exit, allows: (status) => status === "active" },
		],
	};
}
