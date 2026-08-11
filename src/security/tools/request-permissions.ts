/** Agent 主动权限请求工具；自身不创建 grant，只调用 Host governed port。 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../../runtime/types.ts";
import type { PermissionGrant, PermissionGrantScope } from "../permission/grants.ts";
import type { NetworkApprovalProtocol, SecurityResult } from "../types.ts";

const filesystemPermission = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 4096 }),
	access: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("deny")]),
}, { additionalProperties: false });

const networkPermission = Type.Object({
	host: Type.String({ minLength: 1, maxLength: 512 }),
	protocol: Type.Union([Type.Literal("http"), Type.Literal("https"), Type.Literal("socks5-tcp"), Type.Literal("socks5-udp")]),
	port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
	access: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
}, { additionalProperties: false });

export const requestPermissionsSchema = Type.Object({
	scope: Type.Union([Type.Literal("one_off"), Type.Literal("turn"), Type.Literal("session")]),
	permissions: Type.Object({
		filesystem: Type.Optional(Type.Array(filesystemPermission, { minItems: 1, maxItems: 128 })),
		network: Type.Optional(Type.Array(networkPermission, { minItems: 1, maxItems: 128 })),
	}, { additionalProperties: false }),
}, { additionalProperties: false });

export type RequestPermissionsInput = Static<typeof requestPermissionsSchema>;

export interface GovernedPermissionRequest {
	readonly toolCallId: string;
	readonly scope: PermissionGrantScope;
	readonly permissions: {
		readonly filesystem?: readonly { readonly path: string; readonly access: "read" | "write" | "deny" }[];
		readonly network?: readonly { readonly host: string; readonly protocol: NetworkApprovalProtocol; readonly port?: number; readonly access: "allow" | "deny" }[];
	};
}

export interface RequestPermissionsPort {
	request(input: GovernedPermissionRequest, signal?: AbortSignal): Promise<SecurityResult<PermissionGrant>>;
}

export interface RequestPermissionsDetails {
	readonly ok: boolean;
	readonly scope?: PermissionGrantScope;
	readonly grantId?: string;
	readonly code?: string;
}

export function createRequestPermissionsTool(port?: RequestPermissionsPort): AgentTool<typeof requestPermissionsSchema, RequestPermissionsDetails> {
	return {
		name: "request_permissions",
		label: "Request Permissions",
		description: "请求 Host 审批一组精确的临时权限；工具自身不会授予权限。",
		parameters: requestPermissionsSchema,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		async execute(toolCallId, params, signal) {
			if (port === undefined) {
				return { content: [{ type: "text", text: "Permission request denied: governed Host port unavailable." }], details: { ok: false, code: "governed_port_unavailable" }, terminate: false };
			}
			let result: SecurityResult<PermissionGrant>;
			try {
				result = await port.request({ toolCallId, scope: params.scope, permissions: params.permissions }, signal);
			} catch {
				return { content: [{ type: "text", text: "Permission request denied: governed Host port failed." }], details: { ok: false, code: "governed_port_failed" }, terminate: false };
			}
			if (!result.ok) return { content: [{ type: "text", text: `Permission request denied: ${result.error.message}` }], details: { ok: false, code: result.error.code }, terminate: false };
			return {
				content: [{ type: "text", text: `Permission grant approved for ${result.value.scope}.` }],
				details: { ok: true, scope: result.value.scope, grantId: result.value.grantId },
				terminate: false,
			};
		},
	};
}
