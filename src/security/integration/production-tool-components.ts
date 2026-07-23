/** Production Tool Gateway 的 manifest、请求构造与受限 ExecutionEnv 组件。 */

import { randomBytes } from "node:crypto";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	CAPABILITY_GATEWAY_SCHEMA_VERSION,
	capabilityGatewayRequestDigest,
	type CapabilityEventCursorAuthorityPort,
	type CapabilityGatewayRequest,
	type CapabilityClaim,
	type CapabilityName,
	type CapabilityResourceKind,
	type CapabilityRequestAuthentication,
	type SandboxExecutionReceiptRef,
} from "../../runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import {
	isDeclassificationReceiptRef,
	isInputSourceRef,
	type DeclassificationReceiptRef,
	type InputSourceRef,
	type TaintSink,
} from "../../runtime/protocol/v3/taint.ts";
import {
	isWorkspaceValidationReceiptForEnvelope,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceExecutionEnvelope,
} from "../../runtime/protocol/v3/workspace.ts";
import type {
	ExecutionEnv,
	FileStats,
	FileSystem,
	Shell,
	ShellExecOptions,
	ShellResult,
} from "../../runtime/execution-env.ts";
import type {
	ToolExecutionAuthorizationGrant,
	ToolExecutionGatewayRequest,
	ToolSandboxResolutionReceiptRef,
} from "../../runtime/types.ts";
import { pathWithin, PolicyFileSystem, type FileSystemBrokerPort } from "../policy-filesystem.ts";
import { resolveSandboxPolicy } from "../sandbox/policy-resolver.ts";
import type { SandboxBackend, SandboxPrepareRequest } from "../sandbox/types.ts";
import type { SecurityResult, SecuritySnapshot } from "../types.ts";
import type { CapabilityPeerBinding } from "./capability-authentication.ts";
import type {
	SecuritySnapshotResolverPort,
	SecurityToolManifest,
	SecurityToolManifestResolverPort,
} from "./runtime-gateway-adapter.ts";
import type {
	RestrictedToolExecutionEnvironmentPort,
	RestrictedToolExecutionLease,
	RestrictedToolExecutionSettlement,
	ToolExecutionCapabilityRequestFactoryPort,
} from "./tool-execution-gateway.ts";

const SECRET_ENVIRONMENT_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|credential|fencing)/iu;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_AUTHENTICATION_TTL_MS = 300_000;
const MAX_SHELL_OUTPUT_CHARS = 1_000_000;

function failure(message: string, retryable = false): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable } };
}

export interface ProductionToolManifestDefinition {
	toolName: string;
	kind: SecurityToolManifest["kind"];
	primaryCapability: CapabilityName;
	requiredCapabilities: readonly CapabilityName[];
	targetSink: TaintSink;
	/** 自动重试必须由 manifest 显式声明；省略或猜测均不允许。 */
	idempotent: boolean;
	retrySafe: boolean;
	browserOperation?: SecurityToolManifest["browserOperation"];
}

export interface ProductionToolManifest extends SecurityToolManifest {
	primaryCapability: CapabilityName;
	targetSink: TaintSink;
	idempotent: boolean;
	retrySafe: boolean;
}

function manifestBody(definition: ProductionToolManifestDefinition): Omit<ProductionToolManifest, "manifestDigest"> {
	const requiredCapabilities = [...new Set(definition.requiredCapabilities)].sort();
	return {
		toolName: definition.toolName,
		kind: definition.kind,
		primaryCapability: definition.primaryCapability,
		requiredCapabilities,
		targetSink: definition.targetSink,
		idempotent: definition.idempotent,
		retrySafe: definition.retrySafe,
		...(definition.browserOperation === undefined ? {} : { browserOperation: definition.browserOperation }),
	};
}

export function createProductionToolManifest(definition: ProductionToolManifestDefinition): ProductionToolManifest {
	const body = manifestBody(definition);
	if (
		!body.toolName.trim() || body.toolName !== body.toolName.trim() || body.toolName.length > 128 ||
		body.requiredCapabilities.length === 0 || !body.requiredCapabilities.includes(body.primaryCapability) ||
		(body.retrySafe && !body.idempotent)
	) throw new TypeError("production tool manifest is invalid");
	return { ...body, manifestDigest: canonicalDigest({ schemaVersion: 1, ...body }) };
}

export class ProductionToolManifestRegistry implements SecurityToolManifestResolverPort {
	readonly #byDigest = new Map<string, ProductionToolManifest>();
	readonly #byName = new Map<string, ProductionToolManifest>();

	public constructor(manifests: readonly ProductionToolManifest[]) {
		for (const manifest of manifests) {
			const expected = createProductionToolManifest(manifest);
			if (
				expected.manifestDigest !== manifest.manifestDigest ||
				this.#byDigest.has(manifest.manifestDigest) || this.#byName.has(manifest.toolName)
			) throw new TypeError("production tool manifest digest or identity is invalid");
			this.#byDigest.set(manifest.manifestDigest, structuredClone(manifest));
			this.#byName.set(manifest.toolName, structuredClone(manifest));
		}
		if (this.#byName.size === 0) throw new TypeError("production tool manifest registry cannot be empty");
	}

	public forTool(toolName: string): ProductionToolManifest | undefined {
		const manifest = this.#byName.get(toolName);
		return manifest ? structuredClone(manifest) : undefined;
	}

	public async resolve(manifestDigest: string): Promise<SecurityResult<SecurityToolManifest>> {
		const manifest = this.#byDigest.get(manifestDigest);
		return manifest
			? { ok: true, value: structuredClone(manifest) }
			: failure("tool manifest is not registered");
	}
}

export interface ToolInvocationInputClassification {
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
}

/** Context/taint owner 必须返回最终 tool input 的 lineage，不能由 Gateway 猜测为 trusted。 */
export interface ToolInvocationInputClassificationPort {
	classify(
		request: ToolExecutionGatewayRequest,
		envelope: WorkspaceExecutionEnvelope,
		manifest: ProductionToolManifest,
		signal?: AbortSignal,
	): Promise<SecurityResult<ToolInvocationInputClassification>>;
}

export interface ProductionCapabilityRequestFactoryOptions {
	manifests: ProductionToolManifestRegistry;
	snapshots: SecuritySnapshotResolverPort;
	classification: ToolInvocationInputClassificationPort;
	peerBinding: CapabilityPeerBinding;
	eventCursorAuthority: CapabilityEventCursorAuthorityPort;
	clock?: () => Date;
	authenticationTtlMs?: number;
}

function resourceKind(capability: CapabilityName): CapabilityResourceKind {
	switch (capability) {
		case "repository_read":
		case "workspace_write":
		case "dependency_install": return "filesystem";
		case "network": return "network";
		case "process": return "process";
		case "credential": return "credential";
		case "browser": return "browser_tool";
		case "cross_workspace": return "workspace";
		case "deploy": return "native_tool";
	}
}

function validClassification(
	value: ToolInvocationInputClassification,
	envelope: WorkspaceExecutionEnvelope,
): boolean {
	return value.inputSources.every((source) =>
		isInputSourceRef(source) && source.authorityId === envelope.authorityId && source.tenantId === envelope.tenantId,
	) && value.declassificationReceipts.every((receipt) =>
		isDeclassificationReceiptRef(receipt) && receipt.authorityId === envelope.authorityId && receipt.tenantId === envelope.tenantId,
	);
}

export class ProductionCapabilityRequestFactory implements ToolExecutionCapabilityRequestFactoryPort {
	readonly #options: ProductionCapabilityRequestFactoryOptions;
	readonly #clock: () => Date;
	readonly #authenticationTtlMs: number;

	public constructor(options: ProductionCapabilityRequestFactoryOptions) {
		const ttl = options.authenticationTtlMs ?? 30_000;
		if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_AUTHENTICATION_TTL_MS) {
			throw new TypeError("capability authentication ttl is invalid");
		}
		this.#options = options;
		this.#clock = options.clock ?? (() => new Date());
		this.#authenticationTtlMs = ttl;
	}

	public async create(
		request: ToolExecutionGatewayRequest,
		envelope: WorkspaceExecutionEnvelope,
		signal?: AbortSignal,
	): Promise<CapabilityGatewayRequest> {
		if (signal?.aborted) throw new Error("capability request construction was aborted");
		const manifest = this.#options.manifests.forTool(request.tool.name);
		if (!manifest) throw new Error("tool has no production manifest");
		const binding = this.#options.peerBinding;
		if (
			binding.authorityId !== envelope.authorityId || binding.tenantId !== envelope.tenantId ||
			binding.principalId !== envelope.principalId
		) throw new Error("capability peer binding is outside the workspace scope");
		const policyDigest = await this.#options.snapshots.currentPolicyDigest(envelope.workspaceId);
		const snapshot = await this.#options.snapshots.resolve(policyDigest, envelope.workspaceId);
		if (!snapshot.ok || snapshot.value.policyDigest !== policyDigest || snapshot.value.workspaceRoot !== envelope.worktreePath) {
			throw new Error("current security snapshot is unavailable or stale");
		}
		const classification = await this.#options.classification.classify(request, envelope, manifest, signal);
		if (!classification.ok || !validClassification(classification.value, envelope)) {
			throw new Error("tool input classification is unavailable or invalid");
		}
		const environmentDigest = canonicalDigest(request.envVars);
		const argumentsDigest = canonicalDigest(request.arguments);
		const envelopeDigest = workspaceExecutionEnvelopeDigest(envelope);
		const requestId = createRuntimeId("command", `tool-capability-${canonicalDigest({
			toolCallId: request.toolCallId,
			providerToolCallId: request.providerToolCallId,
			manifestDigest: manifest.manifestDigest,
			argumentsDigest,
			environmentDigest,
			envelopeDigest,
			policyDigest,
		}).slice(0, 48)}`);
		const approvalId = createRuntimeId("approval", `tool-capability-${canonicalDigest({
			requestId,
			turnId: request.turnId,
			toolCallId: request.toolCallId,
			runtimeId: envelope.ownerRuntimeId,
			runtimeGeneration: envelope.leaseRevision,
		}).slice(0, 48)}`);
		const constraintsDigest = canonicalDigest({
			manifestDigest: manifest.manifestDigest,
			environmentKeys: Object.keys(request.envVars).sort(),
			environmentDigest,
			envelopeDigest,
			policyDigest,
		});
		const requestedClaims: CapabilityClaim[] = manifest.requiredCapabilities.map((capability) => {
			const kind = resourceKind(capability);
			const base = {
				authorityId: envelope.authorityId,
				tenantId: envelope.tenantId,
				name: capability,
				resourceDigest: canonicalDigest({ capability, argumentsDigest, environmentDigest, envelopeDigest }),
				constraintsDigest,
			};
			return kind === "browser_tool"
				? {
					...base,
					resourceKind: "browser_tool",
					browserConstraints: {
						navigateOriginDigest: canonicalDigest({ capability, operation: "navigate", envelopeDigest }),
						domReadScopeDigest: canonicalDigest({ capability, operation: "dom_read", envelopeDigest }),
						scriptPolicyDigest: canonicalDigest({ capability, operation: "script", policyDigest }),
						downloadScopeDigest: canonicalDigest({ capability, operation: "download", envelopeDigest }),
						uploadScopeDigest: canonicalDigest({ capability, operation: "upload", envelopeDigest }),
						cookieCredentialScopeDigest: canonicalDigest({ capability, operation: "cookie_credential", policyDigest }),
						networkEgressScopeDigest: canonicalDigest({ capability, operation: "network_egress", policyDigest }),
					},
				}
				: { ...base, resourceKind: kind };
		});
		const body = {
			schemaVersion: CAPABILITY_GATEWAY_SCHEMA_VERSION,
			request: {
				authorityId: envelope.authorityId,
				tenantId: envelope.tenantId,
				principalId: envelope.principalId,
				requestId,
				approvalId,
				sessionId: envelope.sessionId,
				runtimeId: envelope.ownerRuntimeId,
				runtimeGeneration: envelope.leaseRevision,
				turnId: request.turnId,
				toolCallId: request.toolCallId,
				capability: manifest.primaryCapability,
				argumentsDigest,
				workspaceEnvelopeDigest: envelopeDigest,
				policyDigest,
				serverScope: "tool_server" as const,
				resourceScopeDigest: canonicalDigest({ tool: request.tool.name, manifestDigest: manifest.manifestDigest }),
				commandScopeDigest: canonicalDigest({ requestId, argumentsDigest, environmentDigest }),
			},
			invocation: {
				requestId,
				toolManifestDigest: manifest.manifestDigest,
				rawArguments: request.arguments,
				envelope,
				requestedClaims,
			},
			idempotencyKey: createRuntimeId("command", `tool-idempotency-${canonicalDigest({ requestId, environmentDigest }).slice(0, 48)}`),
			inputSources: classification.value.inputSources,
			targetSink: manifest.targetSink,
			declassificationReceipts: classification.value.declassificationReceipts,
		};
		const eventCursor = await this.#options.eventCursorAuthority.current({
			authorityId: envelope.authorityId,
			tenantId: envelope.tenantId,
			sessionId: envelope.sessionId,
		});
		if (!eventCursor) throw new Error("capability event cursor authority has no initialized session head");
		const issuedAt = this.#clock();
		const bindingExpiry = binding.expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(binding.expiresAt);
		const expiresAtMs = Math.min(issuedAt.getTime() + this.#authenticationTtlMs, bindingExpiry);
		if (expiresAtMs <= issuedAt.getTime()) throw new Error("capability peer binding is expired");
		const authentication: CapabilityRequestAuthentication = {
			channel: binding.channel,
			channelBindingDigest: binding.channelBindingDigest,
			requestDigest: capabilityGatewayRequestDigest(body),
			nonce: randomBytes(18).toString("base64url"),
			issuedAt: issuedAt.toISOString(),
			expiresAt: new Date(expiresAtMs).toISOString(),
			keyRevision: binding.keyRevision,
			eventCursor,
		};
		return { ...body, authentication };
	}
}

function safeEnvironment(
	value: Readonly<Record<string, string>>,
	allowedKeys: ReadonlySet<string>,
): SecurityResult<Readonly<Record<string, string>>> {
	const output: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!ENVIRONMENT_KEY.test(key) || SECRET_ENVIRONMENT_KEY.test(key) || !allowedKeys.has(key)) {
			return failure("tool environment contains a forbidden key");
		}
		if (entry.includes("\0") || entry.length > 65_536) return failure("tool environment value is invalid");
		output[key] = entry;
	}
	return { ok: true, value: output };
}

class PolicyExecutionFileSystem implements FileSystem {
	readonly #filesystem: PolicyFileSystem;

	public constructor(filesystem: PolicyFileSystem) {
		this.#filesystem = filesystem;
	}

	async #value<T>(operation: Promise<SecurityResult<T>>): Promise<T> {
		const result = await operation;
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		return result.value;
	}

	public readFile(path: string): Promise<Buffer> {
		return this.#value(this.#filesystem.readFile(path));
	}

	public writeFile(path: string, data: string | Buffer): Promise<void> {
		return this.#value(this.#filesystem.writeFile(path, data));
	}

	public async stat(path: string): Promise<FileStats> {
		const value = await this.#value(this.#filesystem.stat(path));
		return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile, isDirectory: value.isDirectory };
	}

	public async readdir(path: string): Promise<string[]> {
		return [...await this.#value(this.#filesystem.readdir(path))];
	}

	public mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		return this.#value(this.#filesystem.mkdir(path, options));
	}

	public rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		return this.#value(this.#filesystem.rm(path, options));
	}
}

interface RestrictedLeaseState {
	grantDigest?: string;
	closed: boolean;
	uncertain: boolean;
	receipts: SandboxExecutionReceiptRef[];
}

interface RestrictedExecutionLeaseOptions {
	request: ToolExecutionGatewayRequest;
	envelope: WorkspaceExecutionEnvelope;
	snapshot: SecuritySnapshot;
	backend: SandboxBackend;
	filesystemBroker: FileSystemBrokerPort;
	resolution: ToolSandboxResolutionReceiptRef;
	baseEnvironment: Readonly<Record<string, string>>;
	toolEnvironment: Readonly<Record<string, string>>;
	allowedEnvironmentKeys: ReadonlySet<string>;
	clock: () => Date;
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n... [output truncated]`;
}

class SandboxedExecutionShell implements Shell {
	readonly #options: RestrictedExecutionLeaseOptions;
	readonly #grant: ToolExecutionAuthorizationGrant;
	readonly #state: RestrictedLeaseState;

	public constructor(
		options: RestrictedExecutionLeaseOptions,
		grant: ToolExecutionAuthorizationGrant,
		state: RestrictedLeaseState,
	) {
		this.#options = options;
		this.#grant = grant;
		this.#state = state;
	}

	public async exec(command: string, options: ShellExecOptions = {}): Promise<ShellResult> {
		if (this.#state.closed) throw new Error("restricted execution lease is already closed");
		if (options.signal?.aborted) throw new Error("sandbox execution was aborted before spawn");
		const cwd = options.cwd ?? this.#options.envelope.cwd;
		if (cwd !== this.#options.envelope.cwd || !pathWithin(this.#options.envelope.worktreePath, cwd)) {
			throw new Error("sandbox cwd is outside the authorized workspace binding");
		}
		const requestedEnvironment = {
			...this.#options.baseEnvironment,
			...this.#options.toolEnvironment,
			...(options.env ?? {}),
		};
		const environment = safeEnvironment(requestedEnvironment, this.#options.allowedEnvironmentKeys);
		if (!environment.ok) throw new Error(environment.error.message);
		const timeoutMs = options.timeoutMs ?? 60_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("sandbox timeout is invalid");
		const prepareRequest: SandboxPrepareRequest = {
			requested: this.#options.resolution.requested,
			policyDigest: this.#options.snapshot.policyDigest,
			envelope: this.#options.envelope,
			readRoots: this.#options.snapshot.filesystem.readRoots,
			writeRoots: this.#options.snapshot.filesystem.writeRoots,
			denyRead: this.#options.snapshot.filesystem.denyRead,
			denyWrite: this.#options.snapshot.filesystem.denyWrite,
			protectedPaths: this.#options.snapshot.filesystem.protectedPaths,
			network: this.#options.snapshot.profile.network.mode === "deny" ? "deny" : "allow",
			command,
			cwd,
			environment: environment.value,
			timeoutMs,
			...(options.stdin === undefined ? {} : { stdin: options.stdin }),
		};
		let prepared: Awaited<ReturnType<SandboxBackend["prepare"]>>;
		try {
			prepared = await this.#options.backend.prepare(prepareRequest);
		} catch {
			throw new Error("sandbox prepare is unavailable");
		}
		if (!prepared.ok) throw new Error("sandbox prepare rejected the command");
		if (
			prepared.value.requested !== this.#options.resolution.requested ||
			prepared.value.resolved !== this.#options.resolution.resolved ||
			prepared.value.policyDigest !== this.#options.snapshot.policyDigest || prepared.value.cwd !== cwd ||
			prepared.value.effectiveEnforcement !== this.#options.resolution.effectiveEnforcement
		) throw new Error("sandbox launch plan is not correlated to its resolution");
		let spawned: Awaited<ReturnType<SandboxBackend["spawn"]>>;
		try {
			spawned = await this.#options.backend.spawn(prepared.value, options.signal);
		} catch {
			this.#state.uncertain = true;
			throw new Error("sandbox spawn outcome is uncertain");
		}
		if (!spawned.ok) {
			this.#state.uncertain = true;
			throw new Error("sandbox process outcome is unavailable");
		}
		const receiptBody = {
			authorityId: this.#options.envelope.authorityId,
			tenantId: this.#options.envelope.tenantId,
			principalId: this.#options.envelope.principalId,
			receiptId: createRuntimeId("receipt", `sandbox-tool-${canonicalDigest({
				grantDigest: this.#grant.grantDigest,
				plan: prepared.value,
				result: spawned.value,
				at: this.#options.clock().toISOString(),
			}).slice(0, 48)}`),
			requestId: this.#grant.authorization.requestId,
			profileId: this.#options.resolution.profileId,
			requested: this.#options.resolution.requested,
			resolved: this.#options.resolution.resolved,
			policyDigest: this.#options.snapshot.policyDigest,
			backendId: prepared.value.backendId,
			effectiveEnforcement: prepared.value.effectiveEnforcement,
			invocationDigest: this.#grant.invocationDigest,
		};
		const receipt: SandboxExecutionReceiptRef = prepared.value.effectiveEnforcement === "degraded"
			? { ...receiptBody, effectiveEnforcement: "degraded", reasonDigest: canonicalDigest(prepared.value.reason ?? "external sandbox enforcement") }
			: prepared.value.effectiveEnforcement === "unavailable"
				? { ...receiptBody, effectiveEnforcement: "unavailable", reasonDigest: canonicalDigest(prepared.value.reason ?? "sandbox unavailable") }
				: { ...receiptBody, effectiveEnforcement: prepared.value.effectiveEnforcement };
		this.#state.receipts.push(receipt);
		const maxChars = Math.min(options.maxOutputChars ?? MAX_SHELL_OUTPUT_CHARS, MAX_SHELL_OUTPUT_CHARS);
		const stdout = truncate(spawned.value.stdout, maxChars);
		const stderr = truncate(spawned.value.stderr, maxChars);
		if (stdout) options.onStdout?.(stdout);
		if (stderr) options.onStderr?.(stderr);
		return { stdout, stderr, exitCode: spawned.value.exitCode, signaled: spawned.value.signaled };
	}
}

class ProductionRestrictedExecutionLease implements RestrictedToolExecutionLease {
	public readonly resolution: ToolSandboxResolutionReceiptRef;
	public readonly toolEnvironment: Readonly<Record<string, string>>;
	readonly #options: RestrictedExecutionLeaseOptions;
	readonly #state: RestrictedLeaseState = { closed: false, uncertain: false, receipts: [] };

	public constructor(options: RestrictedExecutionLeaseOptions) {
		this.#options = options;
		this.resolution = options.resolution;
		this.toolEnvironment = options.toolEnvironment;
	}

	public async open(grant: ToolExecutionAuthorizationGrant): Promise<ExecutionEnv & { governance: {
		kind: "governed";
		grantDigest: string;
		workspaceEnvelopeDigest: string;
		workspaceValidationReceiptId: string;
		authorizationReceiptId: string;
		sandboxResolutionReceiptId: string;
	} }> {
		if (this.#state.closed) throw new Error("restricted execution lease is closed");
		if (this.#state.grantDigest !== undefined && this.#state.grantDigest !== grant.grantDigest) {
			throw new Error("restricted execution lease cannot be rebound");
		}
		this.#state.grantDigest = grant.grantDigest;
		return {
			cwd: this.#options.envelope.cwd,
			fs: new PolicyExecutionFileSystem(new PolicyFileSystem(
				this.#options.filesystemBroker,
				this.#options.envelope.cwd,
				this.#options.snapshot,
			)),
			shell: new SandboxedExecutionShell(this.#options, grant, this.#state),
			governance: {
				kind: "governed",
				grantDigest: grant.grantDigest,
				workspaceEnvelopeDigest: grant.workspaceEnvelopeDigest,
				workspaceValidationReceiptId: grant.workspaceValidation.receiptId,
				authorizationReceiptId: grant.authorization.receiptId,
				sandboxResolutionReceiptId: grant.sandbox.receiptId,
			},
		};
	}

	public async settle(
		_status: "completed" | "failed" | "aborted",
		grant: ToolExecutionAuthorizationGrant,
	): Promise<RestrictedToolExecutionSettlement> {
		if (this.#state.grantDigest !== grant.grantDigest || this.#state.closed) return { outcomeCertain: false };
		this.#state.closed = true;
		if (this.#state.uncertain) return { outcomeCertain: false };
		const sandboxReceipt = this.#state.receipts.at(-1);
		return { outcomeCertain: true, ...(sandboxReceipt === undefined ? {} : { sandboxReceipt }) };
	}
}

export interface ProductionRestrictedToolExecutionEnvironmentOptions {
	snapshots: SecuritySnapshotResolverPort;
	filesystemBroker: FileSystemBrokerPort;
	sandboxBackend: SandboxBackend;
	baseEnvironment?: Readonly<Record<string, string>>;
	allowedEnvironmentKeys?: readonly string[];
	clock?: () => Date;
}

export class ProductionRestrictedToolExecutionEnvironment implements RestrictedToolExecutionEnvironmentPort {
	readonly #options: ProductionRestrictedToolExecutionEnvironmentOptions;
	readonly #baseEnvironment: Readonly<Record<string, string>>;
	readonly #allowedEnvironmentKeys: ReadonlySet<string>;
	readonly #clock: () => Date;

	public constructor(options: ProductionRestrictedToolExecutionEnvironmentOptions) {
		this.#options = options;
		this.#baseEnvironment = { ...(options.baseEnvironment ?? {}) };
		this.#allowedEnvironmentKeys = new Set([
			...Object.keys(this.#baseEnvironment),
			...(options.allowedEnvironmentKeys ?? []),
		]);
		const base = safeEnvironment(this.#baseEnvironment, this.#allowedEnvironmentKeys);
		if (!base.ok) throw new TypeError(base.error.message);
		this.#clock = options.clock ?? (() => new Date());
	}

	public async prepare(
		input: Parameters<RestrictedToolExecutionEnvironmentPort["prepare"]>[0],
		signal?: AbortSignal,
	): ReturnType<RestrictedToolExecutionEnvironmentPort["prepare"]> {
		if (signal?.aborted) return { status: "unavailable", reason: "sandbox preparation was aborted" };
		if (
			input.request.cwd !== input.envelope.cwd ||
			!isWorkspaceValidationReceiptForEnvelope(input.workspaceValidation, input.envelope) ||
			input.authorization.sandboxProfile.authorityId !== input.envelope.authorityId ||
			input.authorization.sandboxProfile.tenantId !== input.envelope.tenantId
		) return { status: "unavailable", reason: "sandbox preparation input is uncorrelated" };
		const toolEnvironment = safeEnvironment(input.request.envVars, this.#allowedEnvironmentKeys);
		if (!toolEnvironment.ok) return { status: "unavailable", reason: toolEnvironment.error.message };
		const snapshot = await this.#options.snapshots.resolve(
			input.authorization.sandboxProfile.policyDigest,
			input.envelope.workspaceId,
		);
		if (
			!snapshot.ok || snapshot.value.policyDigest !== input.authorization.sandboxProfile.policyDigest ||
			snapshot.value.workspaceRoot !== input.envelope.worktreePath ||
			snapshot.value.profile.sandbox !== input.authorization.sandboxProfile.requested ||
			!pathWithin(snapshot.value.workspaceRoot, input.envelope.cwd)
		) return { status: "unavailable", reason: "sandbox security snapshot is unavailable or stale" };
		if (
			snapshot.value.profile.network.mode === "allowlist" &&
			snapshot.value.profile.sandbox !== "off" && snapshot.value.profile.sandbox !== "external"
		) return { status: "unavailable", reason: "shell network allowlist requires a controlled proxy" };
		let capability: Awaited<ReturnType<SandboxBackend["probe"]>>;
		try {
			capability = await this.#options.sandboxBackend.probe();
		} catch {
			return { status: "unavailable", reason: "sandbox backend probe failed" };
		}
		const resolved = resolveSandboxPolicy(input.authorization.sandboxProfile.requested, capability);
		if (!resolved.ok) return { status: "unavailable", reason: resolved.error.message };
		const resolutionBody = {
			receiptId: createRuntimeId("receipt", `sandbox-resolution-${canonicalDigest({
				profile: input.authorization.sandboxProfile,
				envelopeDigest: workspaceExecutionEnvelopeDigest(input.envelope),
				backendId: resolved.value.backendId,
			}).slice(0, 48)}`),
			profileId: input.authorization.sandboxProfile.profileId,
			requested: resolved.value.requested,
			resolved: resolved.value.resolved,
			policyDigest: snapshot.value.policyDigest,
			backendId: resolved.value.backendId,
			effectiveEnforcement: resolved.value.effectiveEnforcement,
			...(resolved.value.reason === undefined ? {} : { reasonDigest: canonicalDigest(resolved.value.reason) }),
		};
		const resolution: ToolSandboxResolutionReceiptRef = {
			...resolutionBody,
			resolutionDigest: canonicalDigest(resolutionBody),
		};
		return {
			status: "ready",
			lease: new ProductionRestrictedExecutionLease({
				request: input.request,
				envelope: input.envelope,
				snapshot: snapshot.value,
				backend: this.#options.sandboxBackend,
				filesystemBroker: this.#options.filesystemBroker,
				resolution,
				baseEnvironment: this.#baseEnvironment,
				toolEnvironment: toolEnvironment.value,
				allowedEnvironmentKeys: this.#allowedEnvironmentKeys,
				clock: this.#clock,
			}),
		};
	}
}
