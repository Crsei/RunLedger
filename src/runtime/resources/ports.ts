/** Resource adapters 只消费 Runtime 统一 port envelope。 */

export type {
	RuntimeResourceCatalogPort,
	RuntimeResourceInvocationPort,
	RuntimeResourceSnapshotPort,
} from "../contracts/ports.ts";

export const RUNTIME_RESOURCE_PORT_NAMES = [
	"resource_catalog",
	"resource_snapshot",
	"resource_invocation",
] as const;
