import { describe, expect, it } from "vitest";
import { ArtifactToolResultSink } from "../../../src/runtime/artifacts/tool-result-sink.ts";
import { createArtifactHarness, valueOf } from "./helpers.ts";

describe("ArtifactToolResultSink", () => {
	it("stores the complete redacted result while exposing only bounded metadata and an ArtifactRef", async () => {
		const harness = await createArtifactHarness();
		try {
			const request = harness.request("tool-result-sink");
			const sink = new ArtifactToolResultSink({
				repository: harness.repository,
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				sessionId: request.source.sessionId,
				producerId: request.source.producerId,
				workspaceId: request.source.workspaceId,
			});
			const projection = await sink.storeToolResult({
				toolCallId: "provider-tool-call-1",
				toolName: "bash",
				content: [{
					type: "text",
					text: "password=hunter2 authorization: Bearer secret-value /home/alice/private.txt",
				}],
				isError: false,
				maxPromptChars: 1_024,
			});
			const prompt = projection.content.map((block) => block.type === "text" ? block.text : "").join("");
			expect(prompt.length).toBeLessThanOrEqual(1_024);
			expect(prompt).toContain(projection.artifactRef.artifactId);
			expect(prompt).not.toContain("hunter2");
			expect(prompt).not.toContain("secret-value");
			expect(prompt).not.toContain("/home/alice");

			const stored = valueOf(await harness.cas.read(projection.artifactRef.storedDigest));
			const storedText = Buffer.from(stored).toString("utf8");
			expect(storedText).toContain("[REDACTED_CREDENTIAL]");
			expect(storedText).toContain("[REDACTED_PATH]");
			expect(storedText).not.toContain("hunter2");
			expect(storedText).not.toContain("secret-value");
		} finally {
			await harness.cleanup();
		}
	});
});
