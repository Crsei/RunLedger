/**
 * Session-scoped RuntimeServer wire protocol(R0 冻结,06 §6)。
 *
 * 只服务构造时绑定的一个 sessionId + generation;只绑定 IPv4 127.0.0.1,
 * 端口传 0 由 OS 分配;不实现 Unix socket / Named Pipe / HTTP / SSE / WebSocket。
 * 首个 frame 是固定大小 initialize(认证前只允许 initialize frame,§4.6)。
 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { SESSION_OWNER_AUTH_TOKEN_BYTES, SESSION_OWNER_ERROR_CODES, type SessionOwnerErrorCode } from "../session-owner/types.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { RuntimeInstanceId, SessionId } from "../protocol/ids.ts";

export const SESSION_PROTOCOL_VERSION = 3 as const;

/** S1:handshake 协商的协议族；不代表某个具体 operation 可用。 */
export const SESSION_PROTOCOL_CAPABILITIES = [
	"session.core",
	"session.catalog",
	"session.process",
	"session.plan",
	"session.extensions",
	"session.mcp",
	"session.hooks",
	"session.skills",
	"session.plugins",
	"session.credential.reverse",
	"session.approval.reverse",
	"session.security.inspect",
	"session.workspace",
	"session.trace.local",
	"session.run-timing",
	"session.multi-agent",
] as const;
export type SessionProtocolCapability = (typeof SESSION_PROTOCOL_CAPABILITIES)[number];

export const SESSION_OPERATION_ACCESS = ["read", "mutate"] as const;
export type SessionOperationAccess = (typeof SESSION_OPERATION_ACCESS)[number];

/** 精确 operation 描述；TUI 只以该清单决定是否构造端口或发送 frame。 */
export interface SessionProtocolOperationDescriptor {
	readonly operation: string;
	readonly capability: SessionProtocolCapability;
	readonly access: SessionOperationAccess;
}

export interface SessionProtocolManifest {
	readonly protocolCapabilities: readonly SessionProtocolCapability[];
	readonly operationManifest: readonly SessionProtocolOperationDescriptor[];
}

/** 当前 SessionRuntime 已真实实现的 core operation；不包含 catalog/process/Host domain。 */
export const SESSION_CORE_OPERATION_MANIFEST: readonly SessionProtocolOperationDescriptor[] = Object.freeze([
	Object.freeze({ operation: "session.snapshot", capability: "session.core", access: "read" }),
	Object.freeze({ operation: "session.timeline", capability: "session.core", access: "read" }),
	Object.freeze({ operation: "session.receipts", capability: "session.core", access: "read" }),
	Object.freeze({ operation: "session.events.subscribe", capability: "session.core", access: "read" }),
	Object.freeze({ operation: "session.driver.claim", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.driver.release", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.provider.status", capability: "session.core", access: "read" }),
	Object.freeze({ operation: "session.model.list", capability: "session.core", access: "read" }),
	Object.freeze({ operation: "session.model.select", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.thinking.set", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.auth.login", capability: "session.credential.reverse", access: "mutate" }),
	Object.freeze({ operation: "session.auth.logout", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.prompt", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.steer", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.follow_up", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.interrupt", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.queue.clear", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.recovery.status", capability: "session.core", access: "read" }),
	Object.freeze({ operation: "session.recovery.assess", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.recovery.verify", capability: "session.core", access: "mutate" }),
	Object.freeze({ operation: "session.recovery.resume", capability: "session.core", access: "mutate" }),
]);

/** 深冻结并校验 capability/operation 对应关系，避免握手后被 composition 改写。 */
export function freezeSessionProtocolManifest(input: SessionProtocolManifest): SessionProtocolManifest {
	const protocolCapabilities = Object.freeze([...new Set(input.protocolCapabilities)]);
	const capabilitySet = new Set<SessionProtocolCapability>(protocolCapabilities);
	const operationNames = new Set<string>();
	const operationManifest = input.operationManifest.map((descriptor) => {
		if (!capabilitySet.has(descriptor.capability)) {
			throw new Error(`operation capability was not negotiated: ${descriptor.operation}`);
		}
		if (operationNames.has(descriptor.operation)) {
			throw new Error(`duplicate session operation: ${descriptor.operation}`);
		}
		operationNames.add(descriptor.operation);
		return Object.freeze({ ...descriptor });
	});
	return Object.freeze({
		protocolCapabilities,
		operationManifest: Object.freeze(operationManifest),
	});
}

export const SESSION_CORE_PROTOCOL_MANIFEST = freezeSessionProtocolManifest({
	protocolCapabilities: ["session.core", "session.credential.reverse", "session.run-timing"],
	operationManifest: SESSION_CORE_OPERATION_MANIFEST,
});

/**
 * §6.1 冻结的会话级传输上限。继承现有 bounded frame/outbox/replay/ACK 语义,
 * 但去掉 Host 级 capacity(maxProcessesPerHost 等)与平台 IPC 项。
 */
export const SESSION_PROTOCOL_BOUNDS = Object.freeze({
	maxFrameBytes: 256 * 1024,
	maxInitializeFrameBytes: 4 * 1024,
	maxConnectionOutbox: 256,
	maxSubscriptionReplay: 2_048,
	maxPreActivationPending: 256,
	maxReverseRequestWaiters: 64,
	maxAckWindow: 256,
	maxSubscriptionsPerClient: 8,
	maxOutputPageBytes: 64 * 1024,
	maxOutputRingBytes: 2 * 1024 * 1024,
	maxInputFrameBytes: 64 * 1024,
	maxProcessesPerSession: 32,
	maxWaitMs: 30_000,
	maxCompletionBatchMembers: 32,
	maxCompletionBatchBytes: 64 * 1024,
} as const);

/** §4.3 sessions.status CHECK 的精确枚举。 */
export const SESSION_STATUSES = [
	"active",
	"recovery_required",
	"paused",
	"completed",
	"failed",
	"archived",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type ClientId = string & { readonly __clientId: unique symbol };

export const SESSION_HANDSHAKE_AUTH_TOKEN_PATTERN = "^[a-f0-9]{64}$" as const;

/**
 * §6.2 handshake initialize frame。认证前只允许这一种固定 frame;
 * authToken 是 32-byte 随机值的 hex 编码,生成时只存 owner row + 内存。
 */
export interface SessionHandshakeRequest {
	readonly protocolVersion: typeof SESSION_PROTOCOL_VERSION;
	readonly sessionId: SessionId;
	readonly expectedRuntimeId: RuntimeInstanceId;
	readonly expectedGeneration: number;
	readonly authToken: string;
	readonly clientId: ClientId;
	readonly clientCapabilities: readonly string[];
}

/**
 * §6.2 handshake 响应。以下情况全部 typed fail closed:
 * session/generation/runtime 不匹配、token 错误、protocol 不兼容、owner
 * 仍在 starting 或已 stopping/fenced、frame 超限/unknown field。
 */
export type SessionHandshakeResponse =
	| {
			readonly accepted: true;
			readonly runtimeId: RuntimeInstanceId;
			readonly generation: number;
			readonly protocolCapabilities: readonly SessionProtocolCapability[];
			readonly operationManifest: readonly SessionProtocolOperationDescriptor[];
			readonly snapshotCursor: number;
			readonly driverRevision: number;
			readonly sessionStatus: SessionStatus;
	  }
	| { readonly accepted: false; readonly code: SessionOwnerErrorCode };

export const SESSION_FRAME_KINDS = [
	"initialize_request",
	"initialize_response",
	"command_request",
	"command_result",
	"query_request",
	"query_result",
	"subscribe_request",
	"subscription_event",
	"ack_cursor",
	"resync_required",
	"reverse_request",
	"reverse_response",
] as const;
export type SessionFrameKind = (typeof SESSION_FRAME_KINDS)[number];

export interface SessionFrameEnvelope {
	readonly frameId: string;
	readonly kind: SessionFrameKind;
	readonly protocolVersion: typeof SESSION_PROTOCOL_VERSION;
	readonly body: Record<string, unknown>;
}

const ScopedIdSchema = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9._~-]{1,128}$`, maxLength: kind.length + 1 + 128 });

const SessionIdSchema = ScopedIdSchema("session");
const RuntimeIdSchema = ScopedIdSchema("runtime");
const ClientIdSchema = Type.String({ pattern: "^client_[A-Za-z0-9._~-]{1,128}$", maxLength: 134 });

const NonNegativeSafeIntSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const PositiveSafeIntSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

const SessionStatusSchema = Type.Unsafe<SessionStatus>({
	type: "string",
	enum: [...SESSION_STATUSES],
});

const SessionProtocolCapabilitySchema = Type.Unsafe<SessionProtocolCapability>({
	type: "string",
	enum: [...SESSION_PROTOCOL_CAPABILITIES],
});

const SessionOperationAccessSchema = Type.Unsafe<SessionOperationAccess>({
	type: "string",
	enum: [...SESSION_OPERATION_ACCESS],
});

const SessionProtocolOperationDescriptorSchema = Type.Object(
	{
		operation: Type.String({ pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", minLength: 1, maxLength: 128 }),
		capability: SessionProtocolCapabilitySchema,
		access: SessionOperationAccessSchema,
	},
	{ additionalProperties: false },
);

export const SessionHandshakeRequestSchema = Type.Object(
	{
		protocolVersion: Type.Literal(SESSION_PROTOCOL_VERSION),
		sessionId: SessionIdSchema,
		expectedRuntimeId: RuntimeIdSchema,
		expectedGeneration: PositiveSafeIntSchema,
		authToken: Type.String({ pattern: SESSION_HANDSHAKE_AUTH_TOKEN_PATTERN, minLength: 64, maxLength: 64 }),
		clientId: ClientIdSchema,
		clientCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
	},
	{ additionalProperties: false },
);

const SessionOwnerErrorCodeSchema = Type.Unsafe<SessionOwnerErrorCode>({
	type: "string",
	enum: [...SESSION_OWNER_ERROR_CODES],
});

const AcceptedHandshakeResponseSchema = Type.Object(
	{
		accepted: Type.Literal(true),
		runtimeId: RuntimeIdSchema,
		generation: PositiveSafeIntSchema,
		protocolCapabilities: Type.Array(SessionProtocolCapabilitySchema, { maxItems: SESSION_PROTOCOL_CAPABILITIES.length, uniqueItems: true }),
		operationManifest: Type.Array(SessionProtocolOperationDescriptorSchema, { maxItems: 256 }),
		snapshotCursor: NonNegativeSafeIntSchema,
		driverRevision: NonNegativeSafeIntSchema,
		sessionStatus: SessionStatusSchema,
	},
	{ additionalProperties: false },
);

const RejectedHandshakeResponseSchema = Type.Object(
	{
		accepted: Type.Literal(false),
		code: SessionOwnerErrorCodeSchema,
	},
	{ additionalProperties: false },
);

export const SessionHandshakeResponseSchema = Type.Union([
	AcceptedHandshakeResponseSchema,
	RejectedHandshakeResponseSchema,
]);

const SessionFrameKindSchema = Type.Unsafe<SessionFrameKind>({
	type: "string",
	enum: [...SESSION_FRAME_KINDS],
});

export const SessionFrameEnvelopeSchema = Type.Object(
	{
		frameId: Type.String({ pattern: "^[A-Za-z0-9._~-]{1,128}$", minLength: 1, maxLength: 128 }),
		kind: SessionFrameKindSchema,
		protocolVersion: Type.Literal(SESSION_PROTOCOL_VERSION),
		body: Type.Record(Type.String({ maxLength: 128 }), Type.Unknown()),
	},
	{ additionalProperties: false },
);

export function isSessionHandshakeRequest(value: unknown): value is SessionHandshakeRequest {
	return Value.Check(SessionHandshakeRequestSchema, value);
}

export function isSessionHandshakeResponse(value: unknown): value is SessionHandshakeResponse {
	return Value.Check(SessionHandshakeResponseSchema, value);
}

export function isSessionFrameEnvelope(value: unknown): value is SessionFrameEnvelope {
	return Value.Check(SessionFrameEnvelopeSchema, value);
}

/**
 * §6.2:handshake 的 session/runtime/generation 必须与当前 owner fence 完全一致。
 * token 校验在 R4 transport 层以 constant-time compare 执行,不进入本纯函数。
 */
export type HandshakeFenceMatch =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "handshake_identity_mismatch" };

export function handshakeMatchesFence(request: SessionHandshakeRequest, fence: OwnerFence): HandshakeFenceMatch {
	if (
		request.sessionId !== fence.sessionId ||
		request.expectedRuntimeId !== fence.runtimeId ||
		request.expectedGeneration !== fence.generation
	) {
		return { ok: false, code: "handshake_identity_mismatch" };
	}
	return { ok: true };
}

export function frameByteLength(envelope: SessionFrameEnvelope): number {
	return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
}

export function isInitializeFrameWithinBound(envelope: SessionFrameEnvelope): boolean {
	return envelope.kind === "initialize_request" && frameByteLength(envelope) <= SESSION_PROTOCOL_BOUNDS.maxInitializeFrameBytes;
}

export { SESSION_OWNER_AUTH_TOKEN_BYTES };
