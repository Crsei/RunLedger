/** security.json 的 exact schema 与 fail-closed 清洗。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
	PERMISSION_PROFILE_NAMES,
	SECURITY_POLICY_SOURCES,
	type SecurityConfigDocument,
	type SecurityConfigLayer,
	type SecurityResult,
} from "../types.ts";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";

const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const pathText = Type.String({ minLength: 1, maxLength: 4096 });
const token = Type.String({ minLength: 1, maxLength: 512 });

export const SecurityConfigDocumentSchema = exact({
	profile: Type.Optional(Type.Union(PERMISSION_PROFILE_NAMES.map((name) => Type.Literal(name)))),
	approvalPolicy: Type.Optional(Type.Union([Type.Literal("on-request"), Type.Literal("never")])),
	sandbox: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("read-only"),
		Type.Literal("workspace-write"),
		Type.Literal("strict"),
		Type.Literal("external"),
	])),
	network: Type.Optional(exact({
		mode: Type.Union([Type.Literal("deny"), Type.Literal("allow"), Type.Literal("allowlist")]),
		allowedHosts: Type.Array(token, { maxItems: 256, uniqueItems: true }),
	})),
	filesystem: Type.Optional(exact({
		readRoots: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
		writeRoots: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
		denyRead: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
		denyWrite: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
		protectedPaths: Type.Optional(Type.Array(pathText, { maxItems: 256, uniqueItems: true })),
	})),
	rules: Type.Optional(Type.Array(exact({
		id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]*$", minLength: 1, maxLength: 128 }),
		action: Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]),
		kind: Type.Union([
			Type.Literal("filesystem"),
			Type.Literal("shell"),
			Type.Literal("network"),
			Type.Literal("worktree"),
			Type.Literal("credential"),
			Type.Literal("browser"),
			Type.Literal("tool"),
		]),
		pattern: token,
	}), { maxItems: 1_024 })),
});

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_config", message, retryable: false } };
}

function validHost(host: string): boolean {
	return (
		host === "*" ||
		(!host.includes("://") && !host.includes("/") && !host.includes("@") && !host.includes("\0"))
	);
}

export function parseSecurityConfigDocument(value: unknown): SecurityResult<SecurityConfigDocument> {
	if (!Check(SecurityConfigDocumentSchema, value)) return failure("security config does not match the exact schema");
	const document = value as SecurityConfigDocument;
	if (document.network) {
		if (document.network.allowedHosts.some((host) => !validHost(host))) return failure("security config contains an invalid network host");
		if (document.network.mode === "deny" && document.network.allowedHosts.length > 0) {
			return failure("network deny mode cannot include allowed hosts");
		}
		if (document.network.mode === "allowlist" && document.network.allowedHosts.length === 0) {
			return failure("network allowlist mode requires at least one host");
		}
	}
	if (document.rules && new Set(document.rules.map((rule) => rule.id)).size !== document.rules.length) {
		return failure("security config contains duplicate rule ids");
	}
	return { ok: true, value: document };
}

export function parseSecurityConfigLayer(
	source: (typeof SECURITY_POLICY_SOURCES)[number],
	text: string,
): SecurityResult<SecurityConfigLayer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return failure(`${source} security config is not valid JSON`);
	}
	const document = parseSecurityConfigDocument(parsed);
	if (!document.ok) return document;
	return {
		ok: true,
		value: { source, document: document.value, documentDigest: canonicalDigest(document.value) },
	};
}
