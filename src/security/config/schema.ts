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
const bashAnalyzerMode = Type.Union([
	Type.Literal("legacy"),
	Type.Literal("shadow"),
	Type.Literal("ast"),
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
	granularApproval: Type.Optional(granularApproval),
	filesystemMode: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write"), Type.Literal("unrestricted")])),
	sandbox: Type.Optional(Type.Union([
		Type.Literal("off"), Type.Literal("read-only"), Type.Literal("workspace-write"), Type.Literal("strict"), Type.Literal("external"),
	])),
	network: Type.Optional(networkPolicy),
	filesystem: Type.Optional(filesystemPolicy),
}, { additionalProperties: false });

export const SecurityConfigDocumentSchema = Type.Object({
	profile: Type.Optional(profileId),
	profiles: Type.Optional(Type.Record(profileId, permissionProfile)),
	approvalPolicy: Type.Optional(approvalPolicy),
	granularApproval: Type.Optional(granularApproval),
	sandbox: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("read-only"),
		Type.Literal("workspace-write"),
		Type.Literal("strict"),
		Type.Literal("external"),
	])),
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
	return { ok: true, value: { source, document: document.value, documentDigest: runtimeDigest(document.value) } };
}

export function securityConfigDigest(document: SecurityConfigDocument): string {
	return canonicalDigest(document);
}
