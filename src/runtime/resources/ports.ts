/**
 * Runtime 资源 adapter ports。
 *
 * TODO(runtime-phase-5): 明确 bounded search、cancel、release 和 event sink 的
 * backpressure/idempotency 语义。实现侧不得通过这些 port 暴露可执行对象。
 */

import type {
	ResourceIdentity,
	ResourceLifecycleEvent,
	RuntimeResourceSnapshot,
	RuntimeToolDescriptor,
	RuntimeToolInvocation,
	RuntimeToolResult,
} from "./types.ts";

export interface RuntimeResourceCatalogPort {
	resolveExact(identity: ResourceIdentity): Promise<RuntimeToolDescriptor | undefined>;
	search(query: string, limit: number): Promise<readonly RuntimeToolDescriptor[]>;
}

export interface RuntimeResourceInvocationPort {
	invoke(invocation: RuntimeToolInvocation, signal?: AbortSignal): Promise<RuntimeToolResult>;
	cancel(requestId: string, reason: string): Promise<void>;
}

export interface RuntimeResourceEventSink {
	append(event: ResourceLifecycleEvent): Promise<void>;
}

export interface RuntimeResourceSnapshotProvider {
	acquire(): Promise<RuntimeResourceSnapshot>;
	release(snapshotId: string): Promise<void>;
}
