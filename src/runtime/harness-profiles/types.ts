/** 会话级 Harness Profile 的被动合同与 exact runtime guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentTool } from "../types.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";
import { RuntimeDigestSchema, RuntimeIdSchema } from "../protocol/foundation-schemas.ts";

export type HarnessProfileId = "standard" | "minimal" | "plan";

export interface HarnessProfileRef {
	readonly id: HarnessProfileId;
	readonly version: 1 | 2;
	readonly descriptorDigest: RuntimeDigest;
}

export interface HarnessProfileDescriptor {
	readonly id: HarnessProfileId;
	readonly version: 1 | 2;
	readonly prompt: {
		readonly mode: "assembled" | "complete";
		/** complete 是完整正文；standard@2 assembled 的 text 是不可替换的固定基座。 */
		readonly text?: string;
	};
	readonly tools: {
		readonly mode: "standard" | "allowlist";
		readonly allowlist: readonly string[];
		readonly allowBackgroundHandle: boolean;
	};
	readonly extensions: {
		readonly tools: boolean;
		readonly context: boolean;
		readonly hooks: boolean;
		readonly lifecycle: boolean;
	};
	readonly multiAgent: boolean;
}

export interface ResolvedHarnessComposition {
	readonly manifestFormat: "descriptor-digests@1";
	readonly ref: HarnessProfileRef;
	readonly systemPrompt: string;
	readonly tools: readonly AgentTool[];
	readonly promptDigest: RuntimeDigest;
	readonly toolManifestDigest: RuntimeDigest;
	readonly contextPolicyDigest: RuntimeDigest;
	readonly compositionDigest: RuntimeDigest;
}

export interface HarnessCompositionReceipt {
	readonly manifestFormat?: "descriptor-digests@1";
	readonly sessionId: string;
	readonly ownerGeneration: number;
	readonly profile: HarnessProfileRef;
	readonly promptDigest: RuntimeDigest;
	readonly tools: readonly {
		readonly name: string;
		readonly descriptorDigest: RuntimeDigest;
	}[];
	readonly toolManifestDigest: RuntimeDigest;
	readonly contextPolicyDigest: RuntimeDigest;
	readonly extensions: HarnessProfileDescriptor["extensions"];
	readonly multiAgent: boolean;
	readonly compositionDigest: RuntimeDigest;
}

export type HarnessProfileResolutionErrorCode =
	| "invalid_harness_profile_ref"
	| "unsupported_harness_profile"
	| "harness_profile_digest_mismatch";

export interface HarnessProfileResolutionError {
	readonly code: HarnessProfileResolutionErrorCode;
	readonly message: string;
}

export type HarnessProfileResolution =
	| {
		readonly ok: true;
		readonly ref: HarnessProfileRef;
		readonly descriptor: HarnessProfileDescriptor;
	}
	| {
		readonly ok: false;
		readonly error: HarnessProfileResolutionError;
	};

const HarnessProfileIdSchema = Type.Union([
	Type.Literal("standard"),
	Type.Literal("minimal"),
	Type.Literal("plan"),
]);

export const HarnessProfileRefSchema = Type.Object(
	{
		id: HarnessProfileIdSchema,
		version: Type.Union([Type.Literal(1), Type.Literal(2)]),
		descriptorDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

const HarnessPromptSchema = Type.Object(
	{
		mode: Type.Union([Type.Literal("assembled"), Type.Literal("complete")]),
		text: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
	},
	{ additionalProperties: false },
);

const HarnessToolsSchema = Type.Object(
	{
		mode: Type.Union([Type.Literal("standard"), Type.Literal("allowlist")]),
		allowlist: Type.Array(
			Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$", minLength: 1, maxLength: 128 }),
			{ maxItems: 64 },
		),
		allowBackgroundHandle: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const HarnessExtensionsSchema = Type.Object(
	{
		tools: Type.Boolean(),
		context: Type.Boolean(),
		hooks: Type.Boolean(),
		lifecycle: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const HarnessProfileDescriptorSchema = Type.Object(
	{
		id: HarnessProfileIdSchema,
		version: Type.Union([Type.Literal(1), Type.Literal(2)]),
		prompt: HarnessPromptSchema,
		tools: HarnessToolsSchema,
		extensions: HarnessExtensionsSchema,
		multiAgent: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const HarnessCompositionReceiptSchema = Type.Object(
	{
		manifestFormat: Type.Optional(Type.Literal("descriptor-digests@1")),
		sessionId: RuntimeIdSchema,
		ownerGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		profile: HarnessProfileRefSchema,
		promptDigest: RuntimeDigestSchema,
		tools: Type.Array(Type.Object(
			{
				name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$", minLength: 1, maxLength: 128 }),
				descriptorDigest: RuntimeDigestSchema,
			},
			{ additionalProperties: false },
		), { maxItems: 128 }),
		toolManifestDigest: RuntimeDigestSchema,
		contextPolicyDigest: RuntimeDigestSchema,
		extensions: HarnessExtensionsSchema,
		multiAgent: Type.Boolean(),
		compositionDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export function isHarnessProfileRef(value: unknown): value is HarnessProfileRef {
	return Value.Check(HarnessProfileRefSchema, value) && supportedIdentity(value.id, value.version);
}

export function isHarnessProfileDescriptor(value: unknown): value is HarnessProfileDescriptor {
	if (!Value.Check(HarnessProfileDescriptorSchema, value) || !supportedIdentity(value.id, value.version)) return false;
	const requiresText = value.prompt.mode === "complete" || (value.id === "standard" && value.version === 2);
	if (requiresText ? value.prompt.text === undefined : value.prompt.text !== undefined) return false;
	if (value.tools.mode === "standard" ? value.tools.allowlist.length !== 0 : value.tools.allowlist.length === 0) return false;
	return new Set(value.tools.allowlist).size === value.tools.allowlist.length;
}

export function isHarnessCompositionReceipt(value: unknown): value is HarnessCompositionReceipt {
	return Value.Check(HarnessCompositionReceiptSchema, value);
}

function supportedIdentity(id: HarnessProfileId, version: number): boolean {
	return version === 1 || ((id === "minimal" || id === "standard") && version === 2);
}
