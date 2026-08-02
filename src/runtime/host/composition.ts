/** Host production/test composition descriptors are intentionally disjoint. */

export interface ProductionHostCompositionDescriptor {
	readonly kind: "production";
	readonly peerAttestor: "linux-so-peercred" | "windows-named-pipe";
	readonly processBackend: "governed";
}

export interface TestHostCompositionDescriptor {
	readonly kind: "test";
	readonly peerAttestor: "test";
	readonly processBackend: "fake";
}

export type HostCompositionDescriptor = ProductionHostCompositionDescriptor | TestHostCompositionDescriptor;

export function createTestHostCompositionDescriptor(): TestHostCompositionDescriptor {
	return {
		kind: "test",
		peerAttestor: "test",
		processBackend: "fake",
	};
}

export function assertProductionHostComposition(
	descriptor: HostCompositionDescriptor,
): ProductionHostCompositionDescriptor {
	if (descriptor.kind !== "production") {
		throw new Error("test composition cannot enter production Host composition");
	}
	return descriptor;
}
