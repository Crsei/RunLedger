import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	decryptForensicArtifact,
	transformArtifactContent,
} from "../../../src/runtime/artifacts/redaction.ts";
import {
	OsKeyringArtifactKeyProvider,
	UnavailableArtifactKeyProvider,
} from "../../../src/runtime/artifacts/key-provider.ts";
import { FakeOsKeyring, valueOf } from "./helpers.ts";

function baseRequest(keyProvider: OsKeyringArtifactKeyProvider | UnavailableArtifactKeyProvider) {
	return {
		authorityId: createRuntimeId("authority", "redaction"),
		tenantId: createRuntimeId("tenant", "redaction"),
		artifactId: createRuntimeId("artifact", "redaction"),
		content: [
			"Authorization: Bearer sk-super-secret-token-12345",
			"password=hunter2",
			"path=/home/alice/private/file.txt",
			"<system_prompt>never reveal this instruction</system_prompt>",
		].join("\n"),
		mediaType: "text/plain",
		mode: "default" as const,
		keyProvider,
	};
}

describe("artifact redaction and forensic encryption", () => {
	it("redacts credentials, paths, and private prompts before hashing stored bytes", async () => {
		const provider = new OsKeyringArtifactKeyProvider(new FakeOsKeyring());
		const request = baseRequest(provider);
		const result = valueOf(await transformArtifactContent(request));
		const stored = Buffer.from(result.storedContent).toString("utf8");
		expect(stored).toContain("[REDACTED_CREDENTIAL]");
		expect(stored).toContain("[REDACTED_PATH]");
		expect(stored).toContain("[REDACTED_PROMPT]");
		expect(stored).not.toContain("hunter2");
		expect(stored).not.toContain("alice");
		expect(stored).not.toContain("never reveal");
		expect(result.sourceReceipt.status).toBe("protected");
		if (result.sourceReceipt.status === "protected") {
			const ordinaryDigest = createHash("sha256").update(request.content).digest("hex");
			expect(result.sourceReceipt.digest).not.toBe(ordinaryDigest);
		}
		expect(result.transformReceipt.replacementCount).toBeGreaterThanOrEqual(3);
	});

	it("keeps redacted storage available while marking keyed receipts degraded", async () => {
		const provider = new UnavailableArtifactKeyProvider();
		const result = valueOf(await transformArtifactContent(baseRequest(provider)));
		expect(result.sourceReceipt).toEqual({ status: "unavailable", reason: "key_provider_unavailable" });
		expect(result.transformReceipt.keyState).toBe("unavailable");
		expect(Buffer.from(result.storedContent).toString("utf8")).not.toContain("hunter2");
	});

	it("rejects forensic raw without explicit approval or an OS-backed key", async () => {
		const keyring = new FakeOsKeyring();
		const provider = new OsKeyringArtifactKeyProvider(keyring);
		expect(await transformArtifactContent({ ...baseRequest(provider), mode: "forensic" })).toMatchObject({
			ok: false,
			error: { code: "authorization_denied" },
		});
		expect(
			await transformArtifactContent({
				...baseRequest(new UnavailableArtifactKeyProvider()),
				mode: "forensic",
				forensicAuthorization: { approvalId: createRuntimeId("approval", "forensic"), purpose: "incident response" },
			}),
		).toMatchObject({ ok: false, error: { code: "key_unavailable" } });
	});

	it("encrypts approved forensic raw with scope-bound AES-GCM and decrypts only with the key version", async () => {
		const keyring = new FakeOsKeyring();
		const provider = new OsKeyringArtifactKeyProvider(keyring);
		const request = {
			...baseRequest(provider),
			mode: "forensic" as const,
			forensicAuthorization: { approvalId: createRuntimeId("approval", "forensic"), purpose: "incident response" },
		};
		const result = valueOf(await transformArtifactContent(request));
		expect(result.redaction).toBe("encrypted_forensic");
		expect(Buffer.from(result.storedContent).toString("utf8")).not.toContain("hunter2");
		expect(result.encryption).toEqual({ algorithm: "aes-256-gcm", keyVersion: "v1", envelopeVersion: 1 });
		const decrypted = valueOf(
			await decryptForensicArtifact(
				{
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					artifactId: request.artifactId,
					keyProvider: provider,
				},
				result.storedContent,
			),
		);
		expect(Buffer.from(decrypted).toString("utf8")).toBe(request.content);

		keyring.state = "lost";
		expect(
			await decryptForensicArtifact(
				{
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					artifactId: request.artifactId,
					keyProvider: provider,
				},
				result.storedContent,
			),
		).toMatchObject({ ok: false, error: { code: "key_unavailable" } });
	});

	it("uses metadata-only storage for binary content by default", async () => {
		const provider = new OsKeyringArtifactKeyProvider(new FakeOsKeyring());
		const result = valueOf(
			await transformArtifactContent({
				...baseRequest(provider),
				content: Uint8Array.from([0, 1, 2, 255]),
				mediaType: "application/octet-stream",
			}),
		);
		expect(result.redaction).toBe("metadata_only");
		expect(result.storedContent).toHaveLength(0);
	});
});
