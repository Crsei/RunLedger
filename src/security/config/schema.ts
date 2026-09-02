/** security 配置的 exact schema 与 fail-closed 清洗。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalDigest, runtimeDigest } from "../../runtime/contracts/public.ts";
import {
	SECURITY_POLICY_SOURCES,
	type SecurityConfigDocument,
	type SecurityConfigLayer,
	type SecurityPolicySource,
	type SecurityResult,
} from "../types.ts";

const pathText = Type.String({ minLength: 1, maxLength: 4096 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const profileId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]*$", minLength: 1, maxLength: 128 });
const approvalPolicy = Type.Union([
	Type.Literal("on-request"),
	Type.Literal("never"),
	Type.Literal("untrusted"),
	Type.Literal("granular"),
]);
const approvalReviewer = Type.Union([Type.Literal("user"), Type.Literal("auto-review")]);
const bashAnalyzerMode = Type.Union([
	Type.Literal("legacy"),
	Type.Literal("shadow"),
	Type.Literal("ast"),
]);
const sandboxProfile = Type.Union([
	Type.Literal("off"),
	Type.Literal("read-only"),
	Type.Literal("workspace-write"),
	Type.Literal("strict"),
	Type.Literal("external"),
]);
const granularApproval = Type.Object({
	sandboxApproval: Type.Boolean(),
	rules: Type.Boolean(),
	skillApproval: Type.Boolean(),
	requestPermissions: Type.Boolean(),
	mcpElicitations: Type.Boolean(),
}, { additionalProperties: false });
const networkPolicy = Type.Object({
	mode: Type.Union([Type.Literal("deny"), Type.Literal("allow"), Type.Literal("allowlist"), Type.Literal("review")]),
	allowedHosts: Type.Array(token, { maxItems: 256, uniqueItems: true }),
}, { additionalProperties: false });
const filesystemPolicy = Type.Object({
	readRoots: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
	writeRoots: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
	denyRead: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
	denyWrite: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
	protectedPaths: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
}, { additionalProperties: false });
const permissionProfile = Type.Object({
	extends: Type.Optional(profileId),
	approvalPolicy: Type.Optional(approvalPolicy),
	approvalReviewer: Type.Optional(approvalReviewer),
	granularApproval: Type.Optional(granularApproval),
	filesystemMode: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write"), Type.Literal("unrestricted")])),
	sandbox: Type.Optional(sandboxProfile),
	network: Type.Optional(networkPolicy),
	filesystem: Type.Optional(filesystemPolicy),
}, { additionalProperties: false });
const managedConstraints = Type.Object({
	allowedProfiles: Type.Array(profileId, { minItems: 1, maxItems: 256, uniqueItems: true }),
	allowedApprovalPolicies: Type.Array(approvalPolicy, { minItems: 1, maxItems: 4, uniqueItems: true }),
	minimumSandbox: sandboxProfile,
	forceNetworkDeny: Type.Boolean(),
	minimumBashAnalyzerMode: Type.Optional(bashAnalyzerMode),
}, { additionalProperties: false });

export const SecurityConfigDocumentSchema = Type.Object({
	profile: Type.Optional(profileId),
	profiles: Type.Optional(Type.Record(profileId, permissionProfile)),
	approvalPolicy: Type.Optional(approvalPolicy),
	approvalReviewer: Type.Optional(approvalReviewer),
	granularApproval: Type.Optional(granularApproval),
	sandbox: Type.Optional(sandboxProfile),
	network: Type.Optional(networkPolicy),
	filesystem: Type.Optional(filesystemPolicy),
	rules: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]*$", minLength: 1, maxLength: 128 }),
		action: Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]),
		kind: Type.Union([
			Type.Literal("filesystem"), Type.Literal("shell"), Type.Literal("network"),
			Type.Literal("worktree"), Type.Literal("tool"),
		]),
		pattern: token,
	}, { additionalProperties: false }), { maxItems: 1024 })),
	bashAnalyzerMode: Type.Optional(bashAnalyzerMode),
	managedConstraints: Type.Optional(managedConstraints),
}, { additionalProperties: false });

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_config", message, retryable: false } };
}

function validHost(host: string): boolean {
	return host === "*" && host.length === 1 ||
		(!host.includes("://") && !host.includes("/") && !host.includes("@") && !host.includes("\0"));
}

export function parseSecurityConfigDocument(value: unknown): SecurityResult<SecurityConfigDocument> {
	if (!Value.Check(SecurityConfigDocumentSchema, value)) return failure("security config does not match the exact schema");
	const document = value as SecurityConfigDocument;
	if (document.approvalPolicy === "granular" && document.granularApproval === undefined) return failure("granular approval policy requires granularApproval");
	if (document.network) {
		if (document.network.allowedHosts.some((host) => !validHost(host))) return failure("security config contains an invalid network host");
		if (document.network.mode === "deny" && document.network.allowedHosts.length > 0) return failure("network deny mode cannot include allowed hosts");
		if (document.network.mode === "allowlist" && document.network.allowedHosts.length === 0) return failure("network allowlist mode requires at least one host");
	}
	if (document.rules && new Set(document.rules.map((rule) => rule.id)).size !== document.rules.length) return failure("security config contains duplicate rule ids");
	return { ok: true, value: document };
}

/**
 * managed 层不是另一份可被优先级挑选的用户配置。它只能声明 ceiling 与
 * deny/ask/protected 等收紧条件，避免 managed profile/network/sandbox 变成
 * 能被 CLI 或 project 语义覆盖的普通基线。
 */
function validateManagedDocument(document: SecurityConfigDocument): SecurityResult<SecurityConfigDocument> {
	if (
		document.profile !== undefined ||
		document.profiles !== undefined ||
		document.approvalPolicy !== undefined ||
		document.approvalReviewer !== undefined ||
		document.granularApproval !== undefined ||
		document.sandbox !== undefined ||
		document.network !== undefined
	) return failure("managed security config may only declare constraints and hardening fields");
	if (document.filesystem?.readRoots !== undefined || document.filesystem?.writeRoots !== undefined) {
		return failure("managed security config may not broaden filesystem roots");
	}
	if (document.rules?.some((rule) => rule.action === "allow")) return failure("managed security config may not allow a rule");
	return { ok: true, value: document };
}

export function parseSecurityConfigLayer(source: SecurityPolicySource, text: string): SecurityResult<SecurityConfigLayer> {
	if (!SECURITY_POLICY_SOURCES.includes(source)) return failure(`unknown security policy source: ${source}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return failure(`${source} security config is not valid JSON`);
	}
	const document = parseSecurityConfigDocument(parsed);
	if (!document.ok) return document;
	if (document.value.managedConstraints !== undefined && source !== "managed" && source !== "organization") {
		return failure("managedConstraints is only valid in a managed or organization security source");
	}
	const constrained = source === "managed" || source === "organization"
		? validateManagedDocument(document.value)
		: document;
	if (!constrained.ok) return constrained;
	return { ok: true, value: { source, document: constrained.value, documentDigest: runtimeDigest(constrained.value) } };
}

export function securityConfigDigest(document: SecurityConfigDocument): string {
	return canonicalDigest(document);
}
