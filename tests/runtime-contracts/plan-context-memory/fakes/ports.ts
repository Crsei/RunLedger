/**
 * Plan/Context/Memory contract consumer 使用的 fake ports。
 *
 * TODO(plan-context-memory-phase-0): contract 冻结后把 fake 补齐为 failure/crash/
 * idempotency fixture；这些 fake 永远不能成为生产 singleton 或真实执行器。
 */

import type { ArtifactRef, CapabilityDecision } from "../../../../src/runtime/protocol/capability.ts";
import type { RuntimeEvent } from "../../../../src/runtime/protocol/events.ts";
import type { RuntimeDigest } from "../../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/ids.ts";
import { resourceIdentityKey } from "../../../../src/runtime/resources/schemas.ts";
import type {
	RuntimeResourceCatalogPort,
	RuntimeResourceEventSink,
	RuntimeResourceInvocationPort,
	RuntimeResourceSnapshotProvider,
} from "../../../../src/runtime/resources/ports.ts";
import type {
	RuntimeResourceSnapshot,
	RuntimeToolDescriptor,
	RuntimeToolInvocation,
	RuntimeToolResult,
} from "../../../../src/runtime/resources/types.ts";

export class FakeEventSink {
	public readonly events: RuntimeEvent[] = [];

	public async append(event: RuntimeEvent): Promise<void> {
		this.events.push(event);
	}
}

export class FakeArtifactStore {
	public async put(kind: ArtifactRef["kind"], digest: RuntimeDigest): Promise<ArtifactRef> {
		return {
			artifactId: createRuntimeId("artifact", "fixture"),
			authorityId: createRuntimeId("authority", "fixture"),
			tenantId: createRuntimeId("tenant", "fixture"),
			storedDigest: digest,
			kind,
			originalSize: 0,
			storedSize: 0,
			mediaType: "text/plain",
			redaction: "metadata_only",
			transformReceiptRef: { subjectKind: "receipt", digest },
		};
	}
}

export class FakeCapabilityGateway {
	public decide(): CapabilityDecision {
		return "deny";
	}
}

export class FakeResourceAdapter
	implements
		RuntimeResourceCatalogPort,
		RuntimeResourceInvocationPort,
		RuntimeResourceEventSink,
		RuntimeResourceSnapshotProvider
{
	public readonly events: Array<Parameters<RuntimeResourceEventSink["append"]>[0]> = [];

	public constructor(
		private readonly descriptors: readonly RuntimeToolDescriptor[],
		private readonly snapshot: RuntimeResourceSnapshot,
	) {}

	public async resolveExact(
		identity: RuntimeToolDescriptor["identity"],
	): Promise<RuntimeToolDescriptor | undefined> {
		const key = resourceIdentityKey(identity);
		return this.descriptors.find((descriptor) => resourceIdentityKey(descriptor.identity) === key);
	}

	public async search(query: string, limit: number): Promise<readonly RuntimeToolDescriptor[]> {
		const normalized = query.toLocaleLowerCase();
		return this.descriptors
			.filter((descriptor) =>
				`${descriptor.runtimeName} ${descriptor.description}`.toLocaleLowerCase().includes(normalized),
			)
			.slice(0, Math.max(0, limit));
	}

	public async invoke(invocation: RuntimeToolInvocation): Promise<RuntimeToolResult> {
		return {
			requestId: invocation.requestId,
			tool: invocation.tool,
			content: [{ type: "text", text: "fake resource result" }],
			outcome: "ok",
			originalBytes: 20,
			truncated: false,
			contentDigest: invocation.inputDigest,
		};
	}

	public async cancel(_requestId: string, _reason: string): Promise<void> {}

	public async append(event: Parameters<RuntimeResourceEventSink["append"]>[0]): Promise<void> {
		this.events.push(event);
	}

	public async acquire(): Promise<RuntimeResourceSnapshot> {
		return this.snapshot;
	}

	public async release(_snapshotId: string): Promise<void> {}
}
