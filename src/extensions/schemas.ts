/** 扩展声明格式的 exact TypeBox schemas。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";

const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const namePattern = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";
const relativeDeclarationPattern = "^\\./[^\\0]+$";
const environmentNamePattern = "^[A-Za-z_][A-Za-z0-9_]*$";
const boundedStringRecord = Type.Record(
	Type.String({ pattern: environmentNamePattern, maxLength: 128 }),
	Type.String({ maxLength: 8_192 }),
	{ maxProperties: 128 },
);

export const PluginManifestSchema = exact({
	schemaVersion: Type.Literal(1),
	name: Type.String({ pattern: namePattern, minLength: 1, maxLength: 64 }),
	version: Type.String({ minLength: 1, maxLength: 64 }),
	description: Type.String({ minLength: 1, maxLength: 2_048 }),
	author: Type.Optional(exact({ name: Type.String({ minLength: 1, maxLength: 256 }) })),
	keywords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64, uniqueItems: true })),
	skills: Type.Optional(Type.Array(Type.String({ pattern: relativeDeclarationPattern, maxLength: 1_024 }), { maxItems: 64, uniqueItems: true })),
	hooks: Type.Optional(Type.Array(Type.String({ pattern: relativeDeclarationPattern, maxLength: 1_024 }), { maxItems: 64, uniqueItems: true })),
	mcpServers: Type.Optional(Type.String({ pattern: relativeDeclarationPattern, maxLength: 1_024 })),
});

export const SkillFrontmatterSchema = exact({
	name: Type.String({ pattern: namePattern, minLength: 1, maxLength: 64 }),
	description: Type.String({ minLength: 1, maxLength: 1_024 }),
	"user-invocable": Type.Optional(Type.Boolean()),
	"disable-model-invocation": Type.Optional(Type.Boolean()),
	"allowed-tools": Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128, uniqueItems: true })),
	metadata: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 1_024 }), { maxProperties: 128 })),
});

export const HookEventSchema = Type.Union([
	Type.Literal("SessionStart"),
	Type.Literal("UserPromptSubmit"),
	Type.Literal("PreToolUse"),
	Type.Literal("PostToolUse"),
	Type.Literal("SessionEnd"),
]);

export const CommandHookHandlerSchema = exact({
	type: Type.Literal("command"),
	command: Type.String({ minLength: 1, maxLength: 4_096 }),
	args: Type.Optional(Type.Array(Type.String({ maxLength: 8_192 }), { maxItems: 256 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
	env: Type.Optional(boundedStringRecord),
});

export const HttpHookHandlerSchema = exact({
	type: Type.Literal("http"),
	url: Type.String({ minLength: 1, maxLength: 4_096 }),
});

export const HookDeclarationV1Schema = exact({
	id: Type.Optional(Type.String({ pattern: namePattern, minLength: 1, maxLength: 64 })),
	matcher: Type.Optional(Type.String({ maxLength: 1_024 })),
	failureMode: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
	handlers: Type.Array(CommandHookHandlerSchema, { minItems: 1, maxItems: 64 }),
});

export const HookDeclarationV2Schema = exact({
	id: Type.Optional(Type.String({ pattern: namePattern, minLength: 1, maxLength: 64 })),
	matcher: Type.Optional(Type.String({ maxLength: 1_024 })),
	failureMode: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
	handlers: Type.Array(Type.Union([CommandHookHandlerSchema, HttpHookHandlerSchema]), { minItems: 1, maxItems: 64 }),
});

const hookEvents = (declaration: TSchema) => exact({
	SessionStart: Type.Optional(Type.Array(declaration, { maxItems: 256 })),
	UserPromptSubmit: Type.Optional(Type.Array(declaration, { maxItems: 256 })),
	PreToolUse: Type.Optional(Type.Array(declaration, { maxItems: 256 })),
	PostToolUse: Type.Optional(Type.Array(declaration, { maxItems: 256 })),
	SessionEnd: Type.Optional(Type.Array(declaration, { maxItems: 256 })),
});

export const HooksConfigV1Schema = exact({
	schemaVersion: Type.Literal(1),
	hooks: hookEvents(HookDeclarationV1Schema),
});

export const HooksConfigV2Schema = exact({
	schemaVersion: Type.Literal(2),
	hooks: hookEvents(HookDeclarationV2Schema),
});

export const HooksConfigSchema = Type.Union([HooksConfigV1Schema, HooksConfigV2Schema]);

const McpCommonSchema = {
	enabled: Type.Optional(Type.Boolean()),
	required: Type.Optional(Type.Boolean()),
	startupTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
	toolTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
	toolTimeouts: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Integer({ minimum: 1, maximum: 3_600_000 }), { maxProperties: 1_024 })),
	enabledTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 2_048, uniqueItems: true })),
	disabledTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 2_048, uniqueItems: true })),
	pinnedTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64, uniqueItems: true })),
	supportsParallelToolCalls: Type.Optional(Type.Boolean()),
} as const;

export const McpStdioServerSchema = exact({
	transport: Type.Literal("stdio"),
	command: Type.String({ minLength: 1, maxLength: 4_096 }),
	args: Type.Optional(Type.Array(Type.String({ maxLength: 8_192 }), { maxItems: 256 })),
	cwd: Type.Optional(Type.String({ maxLength: 4_096 })),
	env: Type.Optional(boundedStringRecord),
	...McpCommonSchema,
});

export const McpHttpServerSchema = exact({
	transport: Type.Literal("streamable-http"),
	url: Type.String({ minLength: 1, maxLength: 4_096 }),
	headers: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.String({ maxLength: 8_192 }), { maxProperties: 128 })),
	bearerTokenEnvVar: Type.Optional(Type.String({ pattern: environmentNamePattern, maxLength: 128 })),
	...McpCommonSchema,
});

export const McpOAuthSchema = exact({
	authorizationServer: Type.String({ minLength: 1, maxLength: 4_096 }),
	scopes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 128, uniqueItems: true })),
	clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
	clientName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

export const McpHttpServerV2Schema = exact({
	transport: Type.Literal("streamable-http"),
	url: Type.String({ minLength: 1, maxLength: 4_096 }),
	headers: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.String({ maxLength: 8_192 }), { maxProperties: 128 })),
	bearerTokenEnvVar: Type.Optional(Type.String({ pattern: environmentNamePattern, maxLength: 128 })),
	oauth: Type.Optional(McpOAuthSchema),
	...McpCommonSchema,
});

export const McpLegacySseServerSchema = exact({
	transport: Type.Literal("sse"),
	url: Type.String({ minLength: 1, maxLength: 4_096 }),
	headers: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.String({ maxLength: 8_192 }), { maxProperties: 128 })),
	legacyTransportExplicitlyEnabled: Type.Literal(true),
	...McpCommonSchema,
});

export const McpServerSchema = Type.Union([McpStdioServerSchema, McpHttpServerSchema, McpLegacySseServerSchema]);
export const McpServerV2Schema = Type.Union([McpStdioServerSchema, McpHttpServerV2Schema, McpLegacySseServerSchema]);
export const McpConfigV1Schema = exact({
	schemaVersion: Type.Literal(1),
	mcpServers: Type.Record(Type.String({ pattern: namePattern, minLength: 1, maxLength: 64 }), McpServerSchema, { maxProperties: 256 }),
});
export const McpConfigV2Schema = exact({
	schemaVersion: Type.Literal(2),
	mcpServers: Type.Record(Type.String({ pattern: namePattern, minLength: 1, maxLength: 64 }), McpServerV2Schema, { maxProperties: 256 }),
});
export const McpConfigSchema = Type.Union([McpConfigV1Schema, McpConfigV2Schema]);

export function schemaAccepts(schema: TSchema, value: unknown): boolean {
	return Check(schema, value);
}
