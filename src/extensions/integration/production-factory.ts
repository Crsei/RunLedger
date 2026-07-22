/** Production interactive runtime 所需的 Extension composition root。 */

import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { computeRuntimeEventPayloadDigest } from "../../runtime/protocol/v3/event-hash.ts";
import { sameRuntimeEventStream, type EventCursor, type RuntimeEventEnvelopeV3 } from "../../runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import type { RuntimeEventDraft } from "../../runtime/session/types.ts";
import type { ContextFragment } from "../../runtime/context/types.ts";
import type {
	GovernedContextFragmentProvider,
	GovernedContextFragmentRequest,
	GovernedContextFragmentResult,
} from "../../runtime/integration/governed-model-request.ts";
import type { AgentToolHookContext, AfterToolCallResult, BeforeToolCallResult, ToolExecutionGatewayPort } from "../../runtime/types.ts";
import type { ToolRegistry } from "../../runtime/tool-registry.ts";
import type { SecuritySnapshot } from "../../security/types.ts";
import type { Tool } from "../../types.ts";
import { validateToolArguments } from "../../utils/validation.ts";
import { NodePolicyExtensionStorage } from "../../storage/extension-node-storage.ts";
import {
	getExtensionSpillDir,
	getExtensionsStatePath,
	getPluginDataRoot,
	getTrustStorePath,
	getUserExtensionRoot,
	resolveSessionDir,
} from "../../storage/paths.ts";
import { ExtensionManager, type ExtensionManagerSnapshot } from "../extension-manager.ts";
import type { HookCommandExecution, HookCommandExecutorPort, HookCommandRequest } from "../hooks/types.ts";
import type {
	McpAuxiliaryAuthorizationPort,
	McpOperationAuthorizationPort,
	McpSchedulerPort,
	McpStateEventSinkPort,
} from "../mcp/connection-manager.ts";
import type { McpClientFactoryPort, McpServerState } from "../mcp/types.ts";
import { discoverExtensionRoots } from "../paths.ts";
import { SkillToolResolver } from "../skills/skill-tool.ts";
import { skillCatalogPromptFragment } from "../skills/renderer.ts";
import { ExtensionStateStore } from "../state-store.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionLifecycleAudit, ExtensionResourceDescriptor, ExtensionRuntimeScope, ExtensionSpillPort, ExtensionSpillRef } from "../types.ts";
import { projectRuntimeSnapshot } from "./runtime-resource-adapter.ts";
import {
	ProductionExtensionRuntime,
	type ProductionExtensionManagerPort,
	type ProductionExtensionManagerSnapshot,
	type ProductionExtensionReloadResult,
	type V3ExtensionCanonicalAuditPort,
} from "./production-runtime.ts";

type CanonicalExtensionEventType = "resource.snapshot" | "resource.lifecycle_recorded";

const MAX_METADATA_BYTES = 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600 as const;
const PRIVATE_DIRECTORY_MODE = 0o700 as const;
const EMPTY_EXTENSION_STATE = Object.freeze({ schemaVersion: 1 as const, revision: 0, resources: Object.freeze({}) });
const EMPTY_TRUST_STATE = Object.freeze({ schemaVersion: 1 as const, revision: 0, records: Object.freeze([]) });

/** EventWriter 的最小结构端口；真实 EventWriter 可直接传入，不复制 sequence/hash 逻辑。 */
export interface ProductionExtensionCanonicalWriterPort {
	append<TType extends CanonicalExtensionEventType>(draft: RuntimeEventDraft<TType>): Promise<
		| {
			ok: true;
			value: {
				event: Pick<RuntimeEventEnvelopeV3<TType>, "stream" | "eventId" | "type" | "payload" | "payloadDigest" | "currentEventHash">;
				cursor: EventCursor;
			};
		}
		| { ok: false }
	>;
	flush(): Promise<{ ok: true; value: EventCursor | undefined } | { ok: false }>;
}

export interface ProductionExtensionPersistencePaths {
	stateFile: string;
	trustFile: string;
	pluginDataRoot: string;
	spillRoot: string;
}

/**
 * MCP transport 可能跨多个 tool call 存活，不能从短生命周期 ToolExecutionGateway
 * 偷拿 lease。调用方若提供本 bundle，clientFactory 必须由独立受限 executor 实现；
 * 工厂不会回退到会直接 spawn/fetch 的 SDK broker。
 */
export interface ProductionSecureMcpPorts {
	clientFactory: McpClientFactoryPort;
	authorization: McpOperationAuthorizationPort;
	auxiliaryAuthorization?: McpAuxiliaryAuthorizationPort;
	scheduler?: McpSchedulerPort;
}

export interface ProductionExtensionFactoryOptions {
	scope: ExtensionRuntimeScope;
	securitySnapshot: SecuritySnapshot;
	writer: ProductionExtensionCanonicalWriterPort;
	userRoot?: string | null;
	builtinRoots?: readonly string[];
	sessionRoots?: readonly string[];
	environment?: Readonly<Record<string, string | undefined>>;
	secureMcp?: ProductionSecureMcpPorts;
	modelContextChars?: number;
	resolvePaths?: (input: { cwd: string; sessionId: string }) => ProductionExtensionPersistencePaths;
	now?: () => Date;
}

export interface ProductionExtensionFactoryCreateInput {
	registry: ToolRegistry;
	gateway: ToolExecutionGatewayPort;
	sessionId: string;
	cwd: string;
}

/** 与 ProductionInteractiveExtensionFactoryPort 结构兼容，且不反向 import storage/CLI composition。 */
export interface ProductionExtensionFactoryResult {
	runtime: ProductionExtensionRuntime;
	beforeToolCall(ctx: AgentToolHookContext, signal?: AbortSignal): Promise<BeforeToolCallResult | void>;
	afterToolCall(ctx: AgentToolHookContext & { result: import("../../runtime/types.ts").ToolResultContent; isError: boolean }, signal?: AbortSignal): Promise<AfterToolCallResult | void>;
	fragmentProviders: readonly GovernedContextFragmentProvider[];
}

function isWithin(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function defaultPaths(cwd: string, sessionId: string): ProductionExtensionPersistencePaths {
	return {
		stateFile: getExtensionsStatePath(),
		trustFile: getTrustStorePath(),
		pluginDataRoot: getPluginDataRoot(),
		spillRoot: getExtensionSpillDir(resolveSessionDir(cwd), sessionId),
	};
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function validStateDocument(value: unknown): boolean {
	const document = plainRecord(value);
	if (!document || document.schemaVersion !== 1 || !Number.isSafeInteger(document.revision) || Number(document.revision) < 0) return false;
	const resources = plainRecord(document.resources);
	if (!resources) return false;
	for (const entryValue of Object.values(resources)) {
		const entry = plainRecord(entryValue);
		if (!entry || typeof entry.enabled !== "boolean" || typeof entry.updatedAt !== "string") return false;
	}
	return true;
}

function validTrustDocument(value: unknown): boolean {
	const document = plainRecord(value);
	if (!document || document.schemaVersion !== 1 || !Number.isSafeInteger(document.revision) || Number(document.revision) < 0 || !Array.isArray(document.records)) return false;
	for (const recordValue of document.records) {
		const record = plainRecord(recordValue);
		if (!record || record.schemaVersion !== 1 || typeof record.receiptDigest !== "string") return false;
		const { receiptDigest, ...body } = record;
		if (canonicalDigest(body) !== receiptDigest) return false;
	}
	return true;
}

function bytesDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function verifyDurableDocument(options: {
	storage: ExtensionStoragePort;
	path: string;
	label: "state" | "trust";
	empty: unknown;
	validate: (value: unknown) => boolean;
}): Promise<void> {
	let read = await options.storage.readFile(options.path, MAX_METADATA_BYTES);
	if (!read.ok) {
		if (read.code !== "missing") throw new Error(`${options.label} metadata is unavailable`);
		const initialized = Buffer.from(`${JSON.stringify(options.empty, null, 2)}\n`);
		const written = await options.storage.writeFileAtomic(options.path, initialized, {
			fileMode: PRIVATE_FILE_MODE,
			directoryMode: PRIVATE_DIRECTORY_MODE,
		});
		if (!written.ok) throw new Error(`${options.label} metadata cannot be initialized`);
		read = await options.storage.readFile(options.path, MAX_METADATA_BYTES);
	}
	if (!read.ok) throw new Error(`${options.label} metadata cannot be read after initialization`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(read.value).toString("utf8"));
	} catch {
		throw new Error(`${options.label} metadata is invalid JSON`);
	}
	if (!options.validate(parsed)) throw new Error(`${options.label} metadata failed integrity validation`);
	const beforeDigest = bytesDigest(read.value);
	const persisted = await options.storage.writeFileAtomic(options.path, read.value, {
		fileMode: PRIVATE_FILE_MODE,
		directoryMode: PRIVATE_DIRECTORY_MODE,
	});
	if (!persisted.ok) throw new Error(`${options.label} metadata is not durably writable`);
	const verified = await options.storage.readFile(options.path, MAX_METADATA_BYTES);
	if (!verified.ok || bytesDigest(verified.value) !== beforeDigest) throw new Error(`${options.label} metadata durability verification failed`);
}

async function verifyProductionPersistence(
	storage: ExtensionStoragePort,
	paths: ProductionExtensionPersistencePaths,
): Promise<void> {
	await verifyDurableDocument({
		storage,
		path: paths.stateFile,
		label: "state",
		empty: EMPTY_EXTENSION_STATE,
		validate: validStateDocument,
	});
	await verifyDurableDocument({
		storage,
		path: paths.trustFile,
		label: "trust",
		empty: EMPTY_TRUST_STATE,
		validate: validTrustDocument,
	});
}

function enabledTrustedMcp(snapshot: ProductionExtensionManagerSnapshot): boolean {
	return snapshot.snapshot.descriptors.some((descriptor) =>
		descriptor.kind === "mcp-server" && descriptor.enabled && descriptor.trust === "trusted"
	);
}

function secureMcpPortsAreComplete(value: ProductionSecureMcpPorts | undefined): value is ProductionSecureMcpPorts {
	return value !== undefined &&
		typeof value.clientFactory?.connect === "function" &&
		typeof value.authorization?.authorize === "function";
}

/** Production reload 前验证持久状态，且拒绝没有显式安全 factory 的 active MCP。 */
class ProductionEnforcedExtensionManager implements ProductionExtensionManagerPort {
	readonly #delegate: ExtensionManager;
	readonly #verifyPersistence: () => Promise<void>;
	readonly #secureMcpConfigured: boolean;

	public constructor(options: {
		delegate: ExtensionManager;
		verifyPersistence: () => Promise<void>;
		secureMcpConfigured: boolean;
	}) {
		this.#delegate = options.delegate;
		this.#verifyPersistence = options.verifyPersistence;
		this.#secureMcpConfigured = options.secureMcpConfigured;
	}

	public current(): ExtensionManagerSnapshot | undefined {
		return this.#delegate.current();
	}

	public beginTurn(): ExtensionManagerSnapshot {
		return this.#delegate.beginTurn();
	}

	async #preflight(): Promise<ProductionExtensionReloadResult | undefined> {
		try {
			await this.#verifyPersistence();
			return undefined;
		} catch (error) {
			return {
				status: "failed",
				reason: boundedFailure("durable extension state/trust persistence is unavailable", error),
				...(this.#delegate.current() ? { retained: this.#delegate.current() } : {}),
			};
		}
	}

	async #enforceMcp(result: ProductionExtensionReloadResult | undefined): Promise<ProductionExtensionReloadResult | undefined> {
		if (result?.status !== "applied" || this.#secureMcpConfigured || !enabledTrustedMcp(result.current)) return result;
		await this.#delegate.close().catch(() => undefined);
		return {
			status: "failed",
			reason: "enabled trusted MCP requires an explicit secure client factory and per-operation authorization",
		};
	}

	public async endTurn(): Promise<ProductionExtensionReloadResult | undefined> {
		const failed = await this.#preflight();
		if (failed) return failed;
		return this.#enforceMcp(await this.#delegate.endTurn());
	}

	public requestReload(): ProductionExtensionReloadResult {
		return this.#delegate.requestReload();
	}

	public async reload(signal?: AbortSignal): Promise<ProductionExtensionReloadResult> {
		const failed = await this.#preflight();
		if (failed) return failed;
		return await this.#enforceMcp(await this.#delegate.reload(signal)) ?? { status: "failed", reason: "extension reload produced no result" };
	}

	public close(): Promise<void> {
		return this.#delegate.close();
	}
}

function lifecycleState(audit: ExtensionLifecycleAudit): "discovered" | "activated" | "deactivated" | "failed" | "revoked" {
	const payload = audit.payload;
	if (audit.kind === "plugin.state/v1") {
		const state = typeof payload.newState === "string" ? payload.newState : "";
		if (state === "revoked") return "revoked";
		if (state === "disabled" || state === "stopped") return "deactivated";
		if (state === "failed" || state === "stale" || state === "blocked") return "failed";
		return state === "ready" || state === "enabled" || state === "trusted" ? "activated" : "discovered";
	}
	if (audit.kind === "mcp.server/v1") {
		const state = typeof payload.newState === "string" ? payload.newState : "";
		if (state === "ready") return "activated";
		if (state === "disabled" || state === "stopped" || state === "stopping") return "deactivated";
		if (state === "failed" || state === "auth-required") return "failed";
		return "discovered";
	}
	if (audit.kind === "hook.run/v1") {
		return payload.status === "failed" || payload.status === "timed_out" || payload.status === "aborted" ? "failed" : "activated";
	}
	if (audit.kind === "mcp.tool/v1") return payload.isError === true ? "failed" : "activated";
	return "activated";
}

function mcpLifecycleState(state: McpServerState): "discovered" | "activated" | "deactivated" | "failed" {
	if (state === "ready") return "activated";
	if (state === "disabled" || state === "stopping" || state === "stopped") return "deactivated";
	if (state === "failed" || state === "auth-required") return "failed";
	return "discovered";
}

class CanonicalExtensionAudit implements V3ExtensionCanonicalAuditPort, McpStateEventSinkPort {
	public readonly mode = "v3" as const;
	readonly #scope: ExtensionRuntimeScope;
	readonly #sessionId: string;
	readonly #writer: ProductionExtensionCanonicalWriterPort;
	readonly #snapshot: () => ExtensionManagerSnapshot | undefined;
	#sequence = 0;

	public constructor(options: {
		scope: ExtensionRuntimeScope;
		sessionId: string;
		writer: ProductionExtensionCanonicalWriterPort;
		snapshot: () => ExtensionManagerSnapshot | undefined;
	}) {
		this.#scope = options.scope;
		this.#sessionId = options.sessionId;
		this.#writer = options.writer;
		this.#snapshot = options.snapshot;
	}

	async #append<TType extends CanonicalExtensionEventType>(draft: RuntimeEventDraft<TType>): Promise<boolean> {
		try {
			const appended = await this.#writer.append(draft);
			if (!appended.ok) return false;
			const { event, cursor } = appended.value;
			if (
				event.stream.scope !== "session" || event.stream.sessionId !== this.#sessionId ||
				cursor.stream.scope !== "session" || cursor.stream.sessionId !== this.#sessionId ||
				event.type !== draft.type || canonicalDigest(event.payload) !== canonicalDigest(draft.payload) ||
				event.payloadDigest !== computeRuntimeEventPayloadDigest(draft.payload) ||
				event.eventId !== cursor.eventId || event.currentEventHash !== cursor.eventHash
			) return false;
			const flushed = await this.#writer.flush();
			if (!flushed.ok || !flushed.value || !sameRuntimeEventStream(flushed.value.stream, cursor.stream) || flushed.value.sequence < cursor.sequence) return false;
			if (flushed.value.sequence === cursor.sequence && (flushed.value.eventId !== cursor.eventId || flushed.value.eventHash !== cursor.eventHash)) return false;
			return true;
		} catch {
			return false;
		}
	}

	#trace(seed: unknown) {
		this.#sequence += 1;
		return createRuntimeId("trace", `extension-${canonicalDigest({ seed, sequence: this.#sequence }).slice(0, 48)}`);
	}

	#descriptor(audit: ExtensionLifecycleAudit): ExtensionResourceDescriptor | undefined {
		const current = this.#snapshot();
		if (!current || audit.sessionId !== this.#sessionId || audit.snapshotId !== current.snapshot.snapshotId || !audit.resourceQualifiedId) return undefined;
		const descriptor = current.snapshot.descriptors.find((item) => item.identity.qualifiedId === audit.resourceQualifiedId);
		if (!descriptor || (audit.resourceId !== undefined && descriptor.identity.resourceId !== audit.resourceId)) return undefined;
		return descriptor;
	}

	async #resource(descriptor: ExtensionResourceDescriptor, state: "discovered" | "activated" | "deactivated" | "failed" | "revoked", timestamp: string, seed: unknown): Promise<boolean> {
		if (descriptor.identity.authorityId !== this.#scope.authorityId || descriptor.identity.tenantId !== this.#scope.tenantId) return false;
		return this.#append({
			type: "resource.lifecycle_recorded",
			principalId: this.#scope.principalId,
			traceId: this.#trace(seed),
			timestamp,
			payload: {
				resourceId: descriptor.identity.resourceId,
				state,
				identityDigest: canonicalDigest(descriptor.identity),
				...(descriptor.approvalReceiptId && (state === "activated" || state === "revoked") ? { receiptId: descriptor.approvalReceiptId } : {}),
			},
		});
	}

	public async appendCanonical(audit: ExtensionLifecycleAudit): Promise<boolean> {
		if (audit.sessionId !== this.#sessionId) return false;
		const current = this.#snapshot();
		if (!current || audit.snapshotId !== current.snapshot.snapshotId) return false;
		if (audit.kind === "extensions.snapshot/v1") {
			const projected = projectRuntimeSnapshot(current.snapshot, this.#scope);
			if (
				audit.payload.digest !== current.snapshot.digest ||
				audit.payload.generation !== current.snapshot.generation ||
				canonicalDigest(audit.payload.counts) !== canonicalDigest(current.snapshot.counts)
			) return false;
			return this.#append({
				type: "resource.snapshot",
				principalId: this.#scope.principalId,
				traceId: this.#trace(audit),
				timestamp: audit.occurredAt,
				payload: {
					snapshotId: projected.snapshotId,
					generation: projected.adapterGeneration,
					resourceCount: projected.resources.length,
					snapshotDigest: projected.digest,
				},
			});
		}
		if (!["plugin.state/v1", "skill.invocation/v1", "hook.run/v1", "mcp.server/v1", "mcp.tool/v1"].includes(audit.kind)) return false;
		const descriptor = this.#descriptor(audit);
		return descriptor ? this.#resource(descriptor, lifecycleState(audit), audit.occurredAt, audit) : false;
	}

	public record(input: Parameters<McpStateEventSinkPort["record"]>[0]): Promise<boolean> {
		if (input.serverId !== input.server.descriptor.identity.qualifiedId) return Promise.resolve(false);
		return this.#resource(input.server.descriptor, mcpLifecycleState(input.newState), input.occurredAt, input);
	}

	public recordTool(input: Parameters<McpStateEventSinkPort["recordTool"]>[0]): Promise<boolean> {
		if (
			input.serverId !== input.server.descriptor.identity.qualifiedId ||
			input.tool.serverId !== input.serverId ||
			input.tool.rawName !== input.toolName ||
			input.tool.runtimeName !== input.runtimeName
		) return Promise.resolve(false);
		const current = this.#snapshot();
		const descriptor = current?.snapshot.descriptors.find((item) => item.kind === "mcp-tool" && item.runtimeName === input.runtimeName);
		return descriptor ? this.#resource(descriptor, input.isError ? "failed" : "activated", input.occurredAt, input) : Promise.resolve(false);
	}
}

export class DurableExtensionSpill implements ExtensionSpillPort {
	readonly #root: string;
	readonly #storage: ExtensionStoragePort;

	public constructor(root: string, storage: ExtensionStoragePort) {
		this.#root = resolve(root);
		this.#storage = storage;
	}

	public async write(kind: "hook-input" | "hook-output" | "mcp-result", bytes: Uint8Array): Promise<ExtensionSpillRef> {
		const digest = createHash("sha256").update(bytes).digest("hex");
		const name = `${kind}-${digest}.bin`;
		const path = join(this.#root, name);
		const written = await this.#storage.writeFileAtomic(path, bytes, { fileMode: 0o600, directoryMode: 0o700 });
		if (!written.ok) throw new Error(`durable extension spill failed: ${written.message}`);
		const verified = await this.#storage.readFile(path, bytes.byteLength);
		if (!verified.ok || createHash("sha256").update(verified.value).digest("hex") !== digest) throw new Error("durable extension spill verification failed");
		return { relativePath: name, digest, bytes: bytes.byteLength };
	}
}

function shellQuote(value: string): string {
	if (value.includes("\0")) throw new Error("hook command contains NUL");
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function hookShellCommand(request: HookCommandRequest): string {
	return `cd -- ${shellQuote(request.cwd)} && exec ${[request.command, ...request.args].map(shellQuote).join(" ")}`;
}

function detailRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function boundedFailure(label: string, error: unknown): string {
	const rawName = error instanceof Error ? error.name : "UnknownError";
	const errorName = rawName.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64) || "UnknownError";
	const errorDigest = canonicalDigest({ errorName, message: error instanceof Error ? error.message : String(error) });
	return `${label} [${errorName}; errorDigest=${errorDigest}]`;
}

function boundedReason(label: string, reason: string): string {
	return `${label} [reasonDigest=${canonicalDigest(reason)}]`;
}

function appendBoundedUtf8(current: string, chunk: string, maxBytes: number): string {
	return boundedUtf8(current + chunk, maxBytes);
}

function boundedUtf8(value: string, maxBytes: number): string {
	const limit = Math.max(0, maxBytes);
	let bounded = Buffer.from(value).subarray(0, limit).toString("utf8");
	while (Buffer.byteLength(bounded) > limit) bounded = bounded.slice(0, -1);
	return bounded;
}

/** Hook command 始终复用注册表中的 production bash identity，避免同名 manifest 替换攻击。 */
export class GatewayHookCommandExecutor implements HookCommandExecutorPort {
	readonly #registry: ToolRegistry;
	readonly #gateway: ToolExecutionGatewayPort;
	readonly #cwd: string;
	readonly #policyDigest: string;
	#sequence = 0;

	public constructor(options: { registry: ToolRegistry; gateway: ToolExecutionGatewayPort; cwd: string; policyDigest: string }) {
		this.#registry = options.registry;
		this.#gateway = options.gateway;
		this.#cwd = options.cwd;
		this.#policyDigest = options.policyDigest;
	}

	public async execute(request: HookCommandRequest, signal?: AbortSignal): Promise<HookCommandExecution> {
		const startedAt = Date.now();
		const tool = this.#registry.get("bash");
		if (!tool || tool.name !== "bash" || tool.governedExecution !== "tool-context") return { status: "failed", exitCode: null, stdout: "", stderr: "production bash tool is unavailable", durationMs: Date.now() - startedAt };
		this.#sequence += 1;
		const command = hookShellCommand(request);
		const argumentsValue = { command, timeout: request.timeoutMs, stdin: request.stdin };
		const correlationDigest = canonicalDigest({
			hookId: request.hookId,
			commandDigest: request.commandDigest,
			stdin: canonicalDigest(request.stdin),
			sequence: this.#sequence,
		});
		const turnId = createRuntimeId("turn", `extension-hook-${correlationDigest.slice(0, 48)}`);
		const toolCallId = createRuntimeId("toolCall", `extension-hook-${correlationDigest.slice(0, 48)}`);
		const invocation = {
			turnId,
			toolCallId,
			providerToolCallId: `extension-hook-${this.#sequence}`,
			tool,
			arguments: argumentsValue,
			cwd: this.#cwd,
			envVars: request.environment,
		};
		let authorized;
		try {
			authorized = await this.#gateway.authorize(invocation, signal);
		} catch (error) {
			return { status: "failed", exitCode: null, stdout: "", stderr: boundedFailure("hook authorization failed", error), durationMs: Date.now() - startedAt };
		}
		if (
			authorized.status !== "authorized" ||
			authorized.grant.capability !== "process" ||
			authorized.grant.toolCallId !== toolCallId ||
			authorized.grant.policyDigest !== this.#policyDigest ||
			authorized.grant.sandbox.policyDigest !== this.#policyDigest ||
			authorized.grant.sandbox.effectiveEnforcement !== "enforced"
		) {
			return { status: authorized.status === "aborted" ? "aborted" : "failed", exitCode: null, stdout: "", stderr: authorized.status === "authorized" ? "hook did not receive a process grant" : boundedReason("hook authorization was not granted", authorized.reason), durationMs: Date.now() - startedAt };
		}
		let stdout = "";
		let stderr = "";
		const executed = await this.#gateway.execute({ invocation, grant: authorized.grant }, (update) => {
			const details = detailRecord(update.details);
			if (typeof details?.stdoutChunk === "string") stdout = appendBoundedUtf8(stdout, details.stdoutChunk, request.maxStdoutBytes);
			if (typeof details?.stderrChunk === "string") stderr = appendBoundedUtf8(stderr, details.stderrChunk, request.maxStderrBytes);
		}, signal).catch((error: unknown) => ({ status: "unavailable" as const, grantDigest: authorized.grant.grantDigest, reason: boundedFailure("hook execution failed", error), outcomeCertain: true as const }));
		if (executed.status !== "completed") {
			return {
				status: executed.status === "aborted" ? "aborted" : "failed",
				exitCode: null,
				stdout: "",
				stderr: boundedReason("hook execution did not complete", executed.reason),
				durationMs: Date.now() - startedAt,
			};
		}
		const receipt = executed.sandboxReceipt;
		if (
			executed.grantDigest !== authorized.grant.grantDigest ||
			!receipt ||
			receipt.requestId !== authorized.grant.authorization.requestId ||
			receipt.profileId !== authorized.grant.sandbox.profileId ||
			receipt.policyDigest !== this.#policyDigest ||
			receipt.backendId !== authorized.grant.sandbox.backendId ||
			receipt.resolved !== authorized.grant.sandbox.resolved ||
			receipt.invocationDigest !== authorized.grant.invocationDigest ||
			receipt.effectiveEnforcement !== "enforced"
		) return { status: "failed", exitCode: null, stdout: "", stderr: "hook execution lacks a current enforced sandbox receipt", durationMs: Date.now() - startedAt };
		const details = detailRecord(executed.result.details);
		if (!stdout && typeof details?.stdout === "string") stdout = boundedUtf8(details.stdout, request.maxStdoutBytes);
		if (!stderr && typeof details?.stderr === "string") stderr = boundedUtf8(details.stderr, request.maxStderrBytes);
		const exitCode = typeof details?.exitCode === "number" && Number.isInteger(details.exitCode) ? details.exitCode : executed.result.isError ? 1 : 0;
		const safeStderr = stderr ? boundedUtf8(boundedReason("hook stderr redacted", stderr), request.maxStderrBytes) : "";
		return { status: "completed", exitCode, stdout: boundedUtf8(stdout, request.maxStdoutBytes), stderr: safeStderr, durationMs: Date.now() - startedAt };
	}
}

class SkillCatalogFragmentProvider implements GovernedContextFragmentProvider {
	readonly #runtime: ProductionExtensionRuntime;
	readonly #modelContextChars: number;

	public constructor(runtime: ProductionExtensionRuntime, modelContextChars: number) {
		this.#runtime = runtime;
		this.#modelContextChars = modelContextChars;
	}

	public load(request: GovernedContextFragmentRequest): GovernedContextFragmentResult {
		const catalog = this.#runtime.catalog();
		if (!catalog) return { fragments: [] };
		const skills = catalog.skills.filter((skill) => skill.descriptor.enabled && skill.descriptor.trust === "trusted" && skill.descriptor.activation === "ready");
		const content = skillCatalogPromptFragment(skills, this.#modelContextChars);
		if (!content) return { fragments: [] };
		const contentDigest = canonicalDigest(content);
		const fragment: ContextFragment = {
			schemaVersion: 1,
			authorityId: request.route.authorityId,
			tenantId: request.route.tenantId,
			fragmentId: createRuntimeId("resource", `extension-catalog-${catalog.snapshotId.slice(-32)}-${catalog.generation}`),
			layer: "workspace_knowledge",
			order: 40,
			contentDigest,
			trust: "user_approved",
			taint: [],
			inputSources: [],
			declassificationReceipts: [],
			priority: "normal",
			maxTokens: Math.max(1, content.length),
			maxChars: Math.max(1, content.length),
			provenance: {
				authorityId: request.route.authorityId,
				tenantId: request.route.tenantId,
				kind: "session_range",
				sessionId: request.sessionId,
				fromSequence: 0,
				toSequence: Math.max(0, request.input.turn),
				sourceDigest: contentDigest,
				observedAt: catalog.createdAt,
			},
			storage: "inline",
			content,
		};
		return { fragments: [fragment] };
	}
}

function validateHookUpdatedInput(context: AgentToolHookContext, input: unknown): BeforeToolCallResult {
	if (!context.tool || context.tool.name !== context.toolCall.name) {
		return { block: true, reason: "PreToolUse hook target does not match the resolved tool" };
	}
	try {
		validateToolArguments(context.tool as unknown as Tool, {
			type: "toolCall",
			id: context.toolCall.id,
			name: context.tool.name,
			arguments: input as Record<string, unknown>,
		});
		return { updatedInput: input };
	} catch (error) {
		return { block: true, reason: boundedFailure("PreToolUse updatedInput failed schema validation", error) };
	}
}

export class ProductionExtensionFactory {
	readonly #options: ProductionExtensionFactoryOptions;

	public constructor(options: ProductionExtensionFactoryOptions) {
		this.#options = options;
	}

	public async create(input: ProductionExtensionFactoryCreateInput): Promise<ProductionExtensionFactoryResult> {
		if (!isWithin(this.#options.securitySnapshot.workspaceRoot, input.cwd)) throw new Error("extension cwd is outside the frozen security snapshot");
		if (!/^[a-f0-9]{64}$/u.test(this.#options.securitySnapshot.policyDigest)) throw new Error("extension security snapshot is invalid");
		if (this.#options.secureMcp !== undefined && !secureMcpPortsAreComplete(this.#options.secureMcp)) throw new Error("secure MCP production ports are incomplete");
		const storage = new NodePolicyExtensionStorage({ cwd: input.cwd, securitySnapshot: this.#options.securitySnapshot });
		const paths = (this.#options.resolvePaths ?? ((value) => defaultPaths(value.cwd, value.sessionId)))(input);
		const roots = await discoverExtensionRoots({
			storage,
			cwd: input.cwd,
			...(this.#options.userRoot === null ? {} : { userRoot: this.#options.userRoot ?? getUserExtensionRoot() }),
			...(this.#options.builtinRoots ? { builtinRoots: this.#options.builtinRoots } : {}),
			...(this.#options.sessionRoots ? { sessionRoots: this.#options.sessionRoots } : {}),
		});
		const trustStore = new TrustStore(paths.trustFile, storage);
		const stateStore = new ExtensionStateStore(paths.stateFile, storage);
		const spill = new DurableExtensionSpill(paths.spillRoot, storage);
		let manager: ProductionEnforcedExtensionManager | undefined;
		const audit = new CanonicalExtensionAudit({ scope: this.#options.scope, sessionId: input.sessionId, writer: this.#options.writer, snapshot: () => manager?.current() });
		const hookExecutor = new GatewayHookCommandExecutor({
			registry: input.registry,
			gateway: input.gateway,
			cwd: input.cwd,
			policyDigest: this.#options.securitySnapshot.policyDigest,
		});
		const extensionManager = new ExtensionManager({
			scope: this.#options.scope,
			roots,
			storage,
			trustStore,
			stateStore,
			pluginDataRoot: paths.pluginDataRoot,
			hookExecutor,
			mcpEvents: audit,
			spill,
			...(this.#options.environment ? { environment: this.#options.environment } : {}),
			...(this.#options.secureMcp ? {
				mcpFactory: this.#options.secureMcp.clientFactory,
				mcpAuthorization: this.#options.secureMcp.authorization,
				...(this.#options.secureMcp.auxiliaryAuthorization ? { mcpAuxiliaryAuthorization: this.#options.secureMcp.auxiliaryAuthorization } : {}),
				...(this.#options.secureMcp.scheduler ? { mcpScheduler: this.#options.secureMcp.scheduler } : {}),
			} : {}),
		});
		manager = new ProductionEnforcedExtensionManager({
			delegate: extensionManager,
			verifyPersistence: () => verifyProductionPersistence(storage, paths),
			secureMcpConfigured: secureMcpPortsAreComplete(this.#options.secureMcp),
		});
		const runtime = new ProductionExtensionRuntime({
			manager,
			registry: input.registry,
			gateway: input.gateway,
			audit,
			sessionId: input.sessionId,
			cwd: input.cwd,
			createSkillResolver: (snapshot) => new SkillToolResolver({
				catalog: snapshot.skillCatalog as import("../skills/catalog.ts").SkillCatalog,
				trustStore,
				principalId: this.#options.scope.principalId,
				storage,
				currentTools: () => input.registry.toContext().map((tool) => tool.name),
			}),
			...(this.#options.now ? { now: this.#options.now } : {}),
		});
		return {
			runtime,
			beforeToolCall: async (context, signal) => {
				if (!context.tool || context.tool.name !== context.toolCall.name) return { block: true, reason: "extension hook cannot authorize an unknown or mismatched tool" };
				const result = await runtime.preToolUseHook({ toolName: context.tool.name, toolInput: context.args }, signal);
				if (result.status === "blocked") return { block: true, reason: boundedReason("PreToolUse hook blocked", result.reason) };
				return result.dispatch.inputUpdated ? validateHookUpdatedInput(context, result.input) : undefined;
			},
			afterToolCall: async (context, signal) => {
				const result = await runtime.postToolUse({ toolName: context.toolCall.name, toolInput: context.args, result: context.result, isError: context.isError }, signal);
				if (result.status !== "blocked") return undefined;
				return {
					isError: true,
					content: [...context.result.content, { type: "text", text: boundedReason("PostToolUse hook failed", result.reason) }],
				};
			},
			fragmentProviders: [new SkillCatalogFragmentProvider(runtime, this.#options.modelContextChars ?? 1_000_000)],
		};
	}
}

export function createProductionExtensionFactory(options: ProductionExtensionFactoryOptions): ProductionExtensionFactory {
	return new ProductionExtensionFactory(options);
}
