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
