/** Plan 工具仅调用 Session-owned authority，不接受文件路径或直接写文件。 */
import { Type } from "typebox";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { AgentTool } from "../types.ts";
import type { SessionPlanDomain } from "./plan-domain.ts";

export function createSessionPlanTools(domain: SessionPlanDomain): readonly AgentTool[] {
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
	const writeSchema = Type.Object({
		expectedRevision: Type.Integer({ minimum: 0, description: "State revision from plan_read" }),
		expectedPlanRevision: Type.Integer({ minimum: 0, description: "Artifact revision from plan_read" }),
		content: Type.String({ minLength: 1, maxLength: 65_536, description: "Complete Markdown plan body; no path or patch" }),
	}, { additionalProperties: false });
	const write: AgentTool<typeof writeSchema> = {
		name: "plan_write", label: "Write plan",
		description: "Replace only the current plan artifact with a new immutable revision. Cannot modify workspace files or approve a plan.",
		parameters: writeSchema,
		capabilityClaims: [{ name: "workspace_write", resourceKind: "filesystem", resourceDigest: runtimeDigest("session-plan-artifact"), constraintsDigest: runtimeDigest("plan-artifact-only"), scope: "invocation" }],
		isReadOnly: () => false, isConcurrencySafe: () => false,
		async execute(toolCallId, input) {
			const result = await domain.mutate("plan.write", input, { expectedRevision: input.expectedRevision, correlationId: toolCallId, effectId: toolCallId });
			return {
				content: [{ type: "text", text: JSON.stringify(result.ok ? result.value : { code: result.code }) }],
				details: {}, ...(result.ok ? {} : { isError: true }),
			};
		},
	};
	return [read, write];
}
