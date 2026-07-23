/** Control Plane schema v2 的 bounded multi-agent wire contracts。 */

import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { ArtifactRefSchema, type ArtifactRef } from "../protocol/v3/capability.ts";
import type { EventCursor, ExpectedRevision } from "../protocol/v3/events.ts";
import { EventCursorSchema, ExpectedRevisionSchema } from "../protocol/v3/event-references.ts";
import type {
	AgentId,
	AuthorityId,
	CommandId,
	PrincipalId,
	SessionId,
	TenantId,
} from "../protocol/v3/ids.ts";
import { AGENT_ROLES, AGENT_STATES, type AgentRole, type AgentState } from "../agents/types.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import {
	ControlPlaneSessionHandleSchema,
	type ControlPlaneSessionHandle,
} from "./types.ts";

export const CONTROL_PLANE_V2_AGENT_COMMAND_TYPES = [
	"agent:spawn",
	"agent:cancel",
	"agent:resume",
	"agent:handoff",
] as const;
export type ControlPlaneV2AgentCommandType =
	(typeof CONTROL_PLANE_V2_AGENT_COMMAND_TYPES)[number];
export const CONTROL_PLANE_V2_AGENT_QUERY_TYPES = ["agent:inspect"] as const;

interface AgentCommandBase<T extends ControlPlaneV2AgentCommandType, P> {
	kind: "command";
	type: T;
	commandId: CommandId;
	idempotencyKey: IdempotencyKey;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	expectedSessionRevision: ExpectedRevision;
	expectedAgentGraphRevision: number;
	sessionHandle: ControlPlaneSessionHandle;
	payload: P;
}

export interface AgentSpawnSpecRef {
	launchSpecArtifact: ArtifactRef;
	launchSpecDigest: string;
	promptArtifact: ArtifactRef;
	promptDigest: string;
	parentAgentId: AgentId;
	childAgentId: AgentId;
	childSessionId: SessionId;
	role: AgentRole;
}

export type AgentSpawnCommandV2 = AgentCommandBase<
	"agent:spawn",
	{ sessionId: SessionId; spec: AgentSpawnSpecRef }
>;
export type AgentCancelCommandV2 = AgentCommandBase<
	"agent:cancel",
	{ sessionId: SessionId; agentId: AgentId; reasonDigest: string }
>;
export type AgentResumeCommandV2 = AgentCommandBase<
	"agent:resume",
	{ sessionId: SessionId; agentId: AgentId; revalidationDigest: string }
>;
export type AgentHandoffCommandV2 = AgentCommandBase<
	"agent:handoff",
	{
		sessionId: SessionId;
		parentAgentId: AgentId;
		childAgentId: AgentId;
		artifactRefs: readonly ArtifactRef[];
		handoffDigest: string;
	}
>;

export type ControlPlaneV2AgentCommand =
	| AgentSpawnCommandV2
	| AgentCancelCommandV2
	| AgentResumeCommandV2
	| AgentHandoffCommandV2;

export interface AgentInspectQueryV2 {
	kind: "query";
	type: "agent:inspect";
	queryId: string;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	payload: {
		sessionId: SessionId;
		sessionHandle: ControlPlaneSessionHandle;
		agentId: AgentId | null;
	};
}

export interface ControlPlaneAgentSummary {
	agentId: AgentId;
	parentAgentId: AgentId | null;
	sessionId: SessionId;
	role: AgentRole;
	state: AgentState;
	residency: "nonresident" | "resident" | "evicted" | "recovering" | "unavailable";
	artifactCount: number;
}

export interface ControlPlaneAgentMutationEffectV2 {
	type: ControlPlaneV2AgentCommandType;
	sessionId: SessionId;
	agent: ControlPlaneAgentSummary;
	graphRevision: number;
	durableCursor: EventCursor;
	receiptDigest: string;
}

export interface AgentInspectionV2 {
	type: "agent:inspect";
	sessionId: SessionId;
	graphRevision: number;
	durableCursor: EventCursor;
	agents: readonly ControlPlaneAgentSummary[];
	projectionDigest: string;
}

const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const idempotencyKey = Type.String({
	pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$",
	maxLength: 128,
});
const role = Type.Union(AGENT_ROLES.map((value) => Type.Literal(value)));
const agentState = Type.Union(AGENT_STATES.map((value) => Type.Literal(value)));

const base = {
	kind: Type.Literal("command"),
	commandId: runtimeId("command"),
	idempotencyKey,
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	expectedSessionRevision: ExpectedRevisionSchema,
	expectedAgentGraphRevision: revision,
	sessionHandle: ControlPlaneSessionHandleSchema,
} as const;
const scopedArtifact = ArtifactRefSchema;
const spawnSpec = exact({
	launchSpecArtifact: scopedArtifact,
	launchSpecDigest: digest,
	promptArtifact: scopedArtifact,
	promptDigest: digest,
	parentAgentId: runtimeId("agent"),
	childAgentId: runtimeId("agent"),
	childSessionId: runtimeId("session"),
	role,
});

export const CONTROL_PLANE_V2_AGENT_COMMAND_SCHEMAS: Readonly<
	Record<ControlPlaneV2AgentCommandType, TSchema>
> = {
	"agent:spawn": exact({
		...base,
		type: Type.Literal("agent:spawn"),
		payload: exact({ sessionId: runtimeId("session"), spec: spawnSpec }),
	}),
	"agent:cancel": exact({
		...base,
		type: Type.Literal("agent:cancel"),
		payload: exact({ sessionId: runtimeId("session"), agentId: runtimeId("agent"), reasonDigest: digest }),
	}),
	"agent:resume": exact({
		...base,
		type: Type.Literal("agent:resume"),
		payload: exact({ sessionId: runtimeId("session"), agentId: runtimeId("agent"), revalidationDigest: digest }),
	}),
	"agent:handoff": exact({
		...base,
		type: Type.Literal("agent:handoff"),
		payload: exact({
			sessionId: runtimeId("session"),
			parentAgentId: runtimeId("agent"),
			childAgentId: runtimeId("agent"),
			artifactRefs: Type.Array(scopedArtifact, { minItems: 1, maxItems: 64 }),
			handoffDigest: digest,
		}),
	}),
};

const AgentInspectQuerySchema = exact({
	kind: Type.Literal("query"),
	type: Type.Literal("agent:inspect"),
	queryId: Type.String({ minLength: 1, maxLength: 128 }),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	payload: exact({
		sessionId: runtimeId("session"),
		sessionHandle: ControlPlaneSessionHandleSchema,
		agentId: Type.Union([runtimeId("agent"), Type.Null()]),
	}),
});

export const ControlPlaneAgentSummarySchema = exact({
	agentId: runtimeId("agent"),
	parentAgentId: Type.Union([runtimeId("agent"), Type.Null()]),
	sessionId: runtimeId("session"),
	role,
	state: agentState,
	residency: Type.Union([
		Type.Literal("nonresident"),
		Type.Literal("resident"),
		Type.Literal("evicted"),
		Type.Literal("recovering"),
		Type.Literal("unavailable"),
	]),
	artifactCount: revision,
});

function invalid(schema: TSchema, value: unknown): ControlPlaneResult<never> {
	const first = [...Errors(schema, value)][0];
	return controlPlaneFailure(
		"invalid_request",
		first?.message ?? "request does not match Control Plane schema v2",
	);
}

export function validateControlPlaneV2AgentCommand(
	value: unknown,
): ControlPlaneResult<ControlPlaneV2AgentCommand> {
	if (!value || typeof value !== "object" || !("type" in value)) {
		return controlPlaneFailure("unknown_command", "unknown Control Plane v2 command");
	}
	const type = (value as { type?: unknown }).type;
	if (
		typeof type !== "string" ||
		!(CONTROL_PLANE_V2_AGENT_COMMAND_TYPES as readonly string[]).includes(type)
	) return controlPlaneFailure("unknown_command", "unknown Control Plane v2 command");
	const schema = CONTROL_PLANE_V2_AGENT_COMMAND_SCHEMAS[type as ControlPlaneV2AgentCommandType];
	if (!Check(schema, value)) return invalid(schema, value);
	const command = value as ControlPlaneV2AgentCommand;
	if (
		command.payload.sessionId !== command.sessionHandle.sessionId ||
		(command.type === "agent:spawn" &&
			(command.payload.spec.childAgentId === command.payload.spec.parentAgentId ||
				command.payload.spec.launchSpecDigest !== command.payload.spec.launchSpecArtifact.storedDigest ||
				command.payload.spec.promptDigest !== command.payload.spec.promptArtifact.storedDigest))
	) return controlPlaneFailure("invalid_request", "Control Plane v2 Agent command correlation is invalid");
	return { ok: true, value: command };
}

export function validateAgentInspectQueryV2(
	value: unknown,
): ControlPlaneResult<AgentInspectQueryV2> {
	if (!Check(AgentInspectQuerySchema, value)) return invalid(AgentInspectQuerySchema, value);
	const query = value as AgentInspectQueryV2;
	if (query.payload.sessionId !== query.payload.sessionHandle.sessionId) {
		return controlPlaneFailure("invalid_request", "Agent inspect handle does not match session");
	}
	return { ok: true, value: query };
}
