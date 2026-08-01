import {
	ResourceIdentitySchema,
	ResourceLifecycleEventSchema,
	RuntimeResourceSnapshotSchema,
} from "../../../src/runtime/contracts/public.ts";
import type {
	ResourceIdentity,
	ResourceLifecycleEvent,
	RuntimeResourceCatalogPort,
	RuntimeResourceInvocationPort,
	RuntimeResourceSnapshot,
	RuntimeResourceSnapshotPort,
} from "../../../src/runtime/contracts/public.ts";

export interface PluginResourceContractConsumer {
	readonly catalog: RuntimeResourceCatalogPort;
	readonly snapshots: RuntimeResourceSnapshotPort;
	readonly invocations: RuntimeResourceInvocationPort;
	acceptIdentity(identity: ResourceIdentity): void;
	acceptSnapshot(snapshot: RuntimeResourceSnapshot): void;
	acceptLifecycleEvent(event: ResourceLifecycleEvent): void;
}

export const PLUGIN_RESOURCE_SCHEMAS = [
	ResourceIdentitySchema,
	RuntimeResourceSnapshotSchema,
	ResourceLifecycleEventSchema,
] as const;
