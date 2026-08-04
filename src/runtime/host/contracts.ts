/** Runtime Host current-format schemas、compatibility digest 与固定边界。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalJson } from "../protocol/canonical-json.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { RuntimeDigestSchema } from "../protocol/foundation-schemas.ts";
import {
	HOST_PROTOCOL_VERSION,
	HOST_SESSION_STORAGE_CONTRACT_VERSION,
	RUNTIME_HOST_BOUNDS,
	type HostCompatibilityEnvelope,
	type HostPeerAttestorDescriptor,
	type RuntimeHostScope,
} from "./types.ts";

export { HOST_PROTOCOL_VERSION, HOST_SESSION_STORAGE_CONTRACT_VERSION, RUNTIME_HOST_BOUNDS } from "./types.ts";
export type { HostCompatibilityEnvelope, RuntimeHostScope } from "./types.ts";

const WorkspaceStorageKeySchema = Type.String({ pattern: "^ws-[a-f0-9]{64}$", minLength: 67, maxLength: 67 });
const scopedIdSchema = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9._~-]{1,128}$`, maxLength: kind.length + 1 + 128 });
const AuthorityIdSchema = scopedIdSchema("authority");
const TenantIdSchema = scopedIdSchema("tenant");
const WorkspaceIdSchema = scopedIdSchema("workspace");
const RepositoryIdSchema = scopedIdSchema("repository");
const HostPeerAttestorKindSchema = Type.Union([
	Type.Literal("linux-so-peercred"),
	Type.Literal("windows-named-pipe"),
	Type.Literal("test"),
]);

export const HostPeerAttestorDescriptorSchema = Type.Object(
	{
		kind: HostPeerAttestorKindSchema,
		generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		configDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export const RuntimeHostScopeSchema = Type.Object(
	{
		authorityId: AuthorityIdSchema,
		tenantId: TenantIdSchema,
		workspaceId: WorkspaceIdSchema,
		repositoryId: RepositoryIdSchema,
		workspaceStorageKey: WorkspaceStorageKeySchema,
		protocolVersion: Type.Literal(HOST_PROTOCOL_VERSION),
		hostBuildDigest: RuntimeDigestSchema,
		compositionDigest: RuntimeDigestSchema,
		settingsDigest: RuntimeDigestSchema,
		modelCatalogDigest: RuntimeDigestSchema,
		tracePolicyDigest: RuntimeDigestSchema,
		securityAdapterDigest: RuntimeDigestSchema,
		extensionProfileDigest: RuntimeDigestSchema,
		sessionStorageContractVersion: Type.Literal(HOST_SESSION_STORAGE_CONTRACT_VERSION),
		peerAttestor: HostPeerAttestorDescriptorSchema,
	},
	{ additionalProperties: false },
);

export const HostCompatibilityEnvelopeSchema = Type.Object(
	{
		...RuntimeHostScopeSchema.properties,
		compatibilityDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export const HostFrameEnvelopeSchema = Type.Object(
	{
		frameId: Type.String({ pattern: "^[A-Za-z0-9._~-]{1,128}$" }),
		kind: Type.Union([
			Type.Literal("initialize_request"),
			Type.Literal("initialize_response"),
			Type.Literal("command_request"),
			Type.Literal("command_result"),
			Type.Literal("query_request"),
			Type.Literal("query_result"),
			Type.Literal("subscribe_request"),
			Type.Literal("subscription_event"),
			Type.Literal("ack_cursor"),
			Type.Literal("resync_required"),
			Type.Literal("reverse_request"),
			Type.Literal("reverse_response"),
		]),
		protocolVersion: Type.Literal(HOST_PROTOCOL_VERSION),
		body: Type.Record(Type.String({ maxLength: 128 }), Type.Unknown()),
	},
	{ additionalProperties: false },
);

function compatibilityPayload(scope: RuntimeHostScope): RuntimeHostScope {
	const { compatibilityDigest: _ignored, ...scopeWithoutDigest } = scope as RuntimeHostScope & {
		readonly compatibilityDigest?: RuntimeHostScope["hostBuildDigest"];
	};
	return {
		...scopeWithoutDigest,
		peerAttestor: { ...scopeWithoutDigest.peerAttestor },
	};
}

export function createHostCompatibilityEnvelope(scope: RuntimeHostScope): HostCompatibilityEnvelope {
	return {
		...scope,
		compatibilityDigest: runtimeDigest({
			scope: compatibilityPayload(scope),
			bounds: RUNTIME_HOST_BOUNDS,
		}),
	};
}

export type HostCompatibilityResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly code: "invalid_compatibility_envelope" | "compatibility_digest_mismatch" | "host_configuration_conflict";
			readonly field?: string;
		};

export function validateHostCompatibility(
	expected: HostCompatibilityEnvelope,
	actual: HostCompatibilityEnvelope,
): HostCompatibilityResult {
	if (!Value.Check(HostCompatibilityEnvelopeSchema, expected) || !Value.Check(HostCompatibilityEnvelopeSchema, actual)) {
		return { ok: false, code: "invalid_compatibility_envelope" };
	}
	const expectedDigest = runtimeDigest({ scope: compatibilityPayload(expected), bounds: RUNTIME_HOST_BOUNDS });
	const actualDigest = runtimeDigest({ scope: compatibilityPayload(actual), bounds: RUNTIME_HOST_BOUNDS });
	if (expected.compatibilityDigest.digest !== expectedDigest.digest || actual.compatibilityDigest.digest !== actualDigest.digest) {
		return { ok: false, code: "compatibility_digest_mismatch" };
	}
	if (canonicalJson(compatibilityPayload(expected)) !== canonicalJson(compatibilityPayload(actual))) {
		return { ok: false, code: "host_configuration_conflict" };
	}
	return { ok: true };
}

export function isRuntimeHostScope(value: unknown): value is RuntimeHostScope {
	return Value.Check(RuntimeHostScopeSchema, value);
}

export function isHostPeerAttestorDescriptor(value: unknown): value is HostPeerAttestorDescriptor {
	return Value.Check(HostPeerAttestorDescriptorSchema, value);
}
