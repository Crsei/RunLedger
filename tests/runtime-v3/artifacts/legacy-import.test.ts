import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactHarness, valueOf } from "./helpers.ts";

describe("legacy tmp import", () => {
	it("imports tool-output-* read-only and labels the evidence legacy/unverified", async () => {
		const harness = await createArtifactHarness();
		try {
			const legacyPath = join(harness.rootDir, "tool-output-42.txt");
			const original = "legacy result password=old-secret";
			await writeFile(legacyPath, original);
			const { content: _content, ...request } = harness.request("legacy");
			const imported = valueOf(await harness.repository.importLegacyTmp({ ...request, legacyPath }));
			expect(imported.state).toBe("committed");
			expect(imported.metadata.evidenceStatus).toBe("legacy_unverified");
			expect(imported.metadata.sourceReceipt).toEqual({ status: "legacy_unverified", reason: "legacy_tmp_import" });
			expect(Buffer.from(valueOf(await harness.cas.read(imported.metadata.storedDigest))).toString("utf8")).not.toContain("old-secret");
			expect(await readFile(legacyPath, "utf8")).toBe(original);
		} finally {
			await harness.cleanup();
		}
	});

	it("does not accept arbitrary legacy paths as verified evidence", async () => {
		const harness = await createArtifactHarness();
		try {
			const legacyPath = join(harness.rootDir, "other.log");
			await writeFile(legacyPath, "content");
			const { content: _content, ...request } = harness.request("legacy-reject");
			expect(await harness.repository.importLegacyTmp({ ...request, legacyPath })).toMatchObject({
				ok: false,
				error: { code: "invalid_request" },
			});
		} finally {
			await harness.cleanup();
		}
	});
});
