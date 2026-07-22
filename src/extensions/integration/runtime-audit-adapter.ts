/** v2 custom 与 Runtime v3 lifecycle 的单一审计投影。 */

import { canonicalDigest, canonicalJson } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import type { RuntimeResourceEventSink } from "../../runtime/resources/ports.ts";
import type {
	ResourceEventEmissionRequest,
	ResourceEventEmissionResult,
	ResourceLifecycleEvent,
} from "../../runtime/resources/types.ts";
import type { ExtensionSnapshot } from "../snapshot.ts";
import type { ExtensionLifecycleAudit, ExtensionResourceDescriptor, ExtensionRuntimeScope } from "../types.ts";

const secretKey = /(authorization|cookie|token|password|secret|api[-_]?key|credential)/iu;

export function redactAuditValue(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[depth-bound]";
	if (typeof value === "string") return value.slice(0, 4_096);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 256).map((item) => redactAuditValue(item, depth + 1));
	if (typeof value !== "object" || value === undefined) return String(value);
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).slice(0, 256)) {
		result[key] = secretKey.test(key) ? "[redacted]" : redactAuditValue(item, depth + 1);
	}
	return result;
}

export function boundedAuditPayload(value: Readonly<Record<string, unknown>>, maxBytes = 64 * 1024): Readonly<Record<string, unknown>> {
	const redacted = redactAuditValue(value) as Readonly<Record<string, unknown>>;
	const encoded = canonicalJson(redacted);
	if (Buffer.byteLength(encoded) <= maxBytes) return redacted;
	return { truncated: true, originalBytes: Buffer.byteLength(encoded), digest: canonicalDigest(redacted) };
}

export function snapshotAudit(
	snapshot: ExtensionSnapshot,
	sessionId: string,
): ExtensionLifecycleAudit {
	return {
		schemaVersion: 1,
		kind: "extensions.snapshot/v1",
		sessionId,
		snapshotId: snapshot.snapshotId,
		occurredAt: snapshot.createdAt,
		payload: boundedAuditPayload({ digest: snapshot.digest, generation: snapshot.generation, counts: snapshot.counts, diagnostics: snapshot.diagnostics.map(({ code, severity, resourceId }) => ({ code, severity, resourceId })) }),
	};
}

export function resourceAudit(input: {
	kind: "plugin.state/v1" | "skill.invocation/v1" | "hook.run/v1" | "mcp.server/v1" | "mcp.tool/v1";
	sessionId: string;
	snapshotId: string;
	descriptor: ExtensionResourceDescriptor;
	occurredAt: string;
	payload: Readonly<Record<string, unknown>>;
}): ExtensionLifecycleAudit {
	return {
		schemaVersion: 1,
		kind: input.kind,
		sessionId: input.sessionId,
		snapshotId: input.snapshotId,
		resourceId: input.descriptor.identity.resourceId,
		resourceQualifiedId: input.descriptor.identity.qualifiedId,
		occurredAt: input.occurredAt,
		payload: boundedAuditPayload(input.payload),
	};
}

export function lifecycleEvent(input: {
	scope: ExtensionRuntimeScope;
	descriptor: ExtensionResourceDescriptor;
	snapshot: ExtensionSnapshot;
	state: "discovered" | "approved" | "revoked" | "activated" | "deactivated" | "failed";
	correlationSeed: string;
	occurredAt: string;
	reasonCode?: string;
	receiptId?: ExtensionResourceDescriptor["approvalReceiptId"];
	revocationRevision?: number;
}): ResourceLifecycleEvent {
	const common = {
		schemaVersion: 1 as const,
		...input.scope,
		identity: input.descriptor.identity,
		identityDigest: canonicalDigest(input.descriptor.identity),
		snapshotId: input.snapshot.snapshotId,
		adapterGeneration: input.snapshot.generation,
		correlationId: createRuntimeId("trace", canonicalDigest(input.correlationSeed).slice(0, 32)),
		occurredAt: input.occurredAt,
	};
	if (input.state === "approved") {
		if (!input.receiptId) throw new Error("approved lifecycle requires receipt");
		return { ...common, state: "approved", receiptId: input.receiptId };
	}
	if (input.state === "activated") {
		if (!input.receiptId) throw new Error("activated lifecycle requires receipt");
		return { ...common, state: "activated", receiptId: input.receiptId };
	}
	if (input.state === "revoked") {
		if (!input.receiptId) throw new Error("revoked lifecycle requires receipt");
		return { ...common, state: "revoked", receiptId: input.receiptId, revocationRevision: input.revocationRevision ?? 0 };
	}
	if (input.state === "failed") {
		const reasonCode = input.reasonCode ?? "extension_failed";
		return { ...common, state: "failed", reasonCode, reasonDigest: canonicalDigest(reasonCode) };
	}
	if (input.state === "deactivated") {
		return { ...common, state: "deactivated", ...(input.reasonCode ? { reasonCode: input.reasonCode, reasonDigest: canonicalDigest(input.reasonCode) } : {}) };
	}
	return { ...common, state: "discovered" };
}

export interface DurableResourceEventWriterPort {
	emit(request: ResourceEventEmissionRequest): Promise<ResourceEventEmissionResult>;
}

export class ExtensionRuntimeEventSinkAdapter implements RuntimeResourceEventSink {
	readonly #writer?: DurableResourceEventWriterPort;
	readonly #scope: ExtensionRuntimeScope;

	public constructor(scope: ExtensionRuntimeScope, writer?: DurableResourceEventWriterPort) {
		this.#scope = scope;
		this.#writer = writer;
	}

	public async emit(request: ResourceEventEmissionRequest): Promise<ResourceEventEmissionResult> {
		if (!this.#writer) {
			return {
				schemaVersion: 1,
				...this.#scope,
				idempotencyKey: request.idempotencyKey,
				status: "rejected",
				error: { code: "unavailable", messageDigest: canonicalDigest("durable event sink unavailable"), retryable: true },
			};
		}
		return this.#writer.emit(request);
	}
}
