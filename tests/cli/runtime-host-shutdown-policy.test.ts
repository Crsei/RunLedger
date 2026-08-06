import { describe, expect, it } from "vitest";
import { evaluateHostShutdownActivity } from "../../src/cli/runtime-host-service.ts";

describe("Host shutdown activity policy", () => {
	it("requires explicit confirmation for either active turns or managed processes", () => {
		expect(evaluateHostShutdownActivity({ activeTurnCount: 0, managedProcessCount: 1, confirmActive: false })).toEqual({
			ok: false,
			code: "host_busy",
			activeTurnCount: 0,
			managedProcessCount: 1,
		});
		expect(evaluateHostShutdownActivity({ activeTurnCount: 1, managedProcessCount: 0, confirmActive: false })).toMatchObject({ ok: false, code: "host_busy" });
		expect(evaluateHostShutdownActivity({ activeTurnCount: 2, managedProcessCount: 3, confirmActive: true })).toEqual({
			ok: true,
			activeTurnCount: 2,
			managedProcessCount: 3,
		});
	});
});
