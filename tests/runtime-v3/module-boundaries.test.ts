import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_BOUNDARY_MANIFEST, scanRuntimeBoundaries } from "../../scripts/check-runtime-boundaries.ts";

describe("Runtime module boundaries", () => {
	it("keeps the current contract graph within manifest rules", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		expect(RUNTIME_BOUNDARY_MANIFEST.version).toBe(1);
		expect(scanRuntimeBoundaries(repoRoot)).toEqual([]);
	});

	it("detects protocol, gateway, and projection violations", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-boundary-"));
		try {
			const protocol = join(root, "src/runtime/protocol/v3");
			const gateway = join(root, "src/runtime/gateway");
			const session = join(root, "src/runtime/session");
			for (const directory of [protocol, gateway, session]) mkdirSync(directory, { recursive: true });
			writeFileSync(join(protocol, "bad.ts"), 'import "../../../storage/session-manager.ts";\n');
			writeFileSync(join(gateway, "bad.ts"), 'import "../../tui/index.ts";\n');
			writeFileSync(join(session, "projection.ts"), 'import "./event-store.ts";\nstore.append(event);\n');
			const violations = scanRuntimeBoundaries(root);
			expect(violations.map((violation) => violation.ruleId)).toEqual([
				"gateway-does-not-depend-on-ui",
				"protocol-is-pure",
				"projection-does-not-write-store",
				"projection-does-not-write-store",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
