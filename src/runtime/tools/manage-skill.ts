/** Canonical user-skill 的模型侧管理工具。 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";
import type { ManageSkillAction, ManageSkillInput, ManageSkillStoreResult } from "../../extensions/skills/managed-store.ts";

export const manageSkillSchema = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]),
	name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
	description: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
	body: Type.Optional(Type.String({ minLength: 1, maxLength: 1_048_576 })),
}, { additionalProperties: false });

export type ManageSkillToolInput = Static<typeof manageSkillSchema>;

export interface ManageSkillPort {
	mutate(input: ManageSkillInput, signal?: AbortSignal): Promise<ManageSkillStoreResult>;
}

export function createManageSkillTool(port?: ManageSkillPort): AgentTool<typeof manageSkillSchema, ManageSkillStoreResult> {
	return {
		name: "manage_skill",
		label: "Manage Skill",
		description: "Create, update, or delete a RunLedger-managed user skill. It never writes project or external compatibility skill directories, and newly written skills remain untrusted until the user trusts them.",
		parameters: manageSkillSchema,
		isDestructive: () => true,
		async execute(_toolCallId, params, signal) {
			if (port === undefined) throw new Error("manage_skill port 未注入");
			const result = await port.mutate({
				action: params.action as ManageSkillAction,
				name: params.name,
				...(params.description === undefined ? {} : { description: params.description }),
				...(params.body === undefined ? {} : { body: params.body }),
			}, signal);
			const suffix = result.ok && result.reload === "pending"
				? " Discovery will refresh after this turn."
				: result.ok && result.reload === "failed"
					? " The skill was saved, but discovery refresh failed; reopen the session to retry."
					: "";
			return {
				content: [{ type: "text" as const, text: result.ok ? `Managed skill ${result.name} ${result.action}d.${suffix}` : `manage_skill failed: ${result.code}.` }],
				details: result,
				...(result.ok ? {} : { isError: true }),
			};
		},
	};
}
