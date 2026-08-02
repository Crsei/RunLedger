import { describe, expect, it } from "vitest";
import {
	assertProductionHostComposition,
	createTestHostCompositionDescriptor,
	type ProductionHostCompositionDescriptor,
} from "../../../src/runtime/host/composition.ts";

describe("R1 Host composition boundary", () => {
	it("does not allow a test attestor/backend descriptor into production composition", () => {
		const testComposition = createTestHostCompositionDescriptor();
		expect(() => assertProductionHostComposition(testComposition)).toThrow(/test composition/u);
	});

	it("accepts only explicitly governed production descriptor", () => {
		const production: ProductionHostCompositionDescriptor = {
			kind: "production",
			peerAttestor: "linux-so-peercred",
			processBackend: "governed",
		};
		expect(assertProductionHostComposition(production)).toEqual(production);
	});
});
