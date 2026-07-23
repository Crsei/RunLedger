import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { ArtifactAccessService, ArtifactReadLeaseRegistry } from "../../../src/runtime/artifacts/access.ts";
import type {
	ArtifactAccessLogEntry,
	ArtifactAccessLogPort,
	ArtifactCapabilityDecision,
	ArtifactCapabilityRequest,
	ArtifactResult,
	ArtifactCapabilityGatewayPort,
} from "../../../src/runtime/artifacts/types.ts";
import { createArtifactHarness, NOW, valueOf } from "./helpers.ts";

class FakeGateway implements ArtifactCapabilityGatewayPort {
	decision: ArtifactCapabilityDecision["decision"] = "allow";
	requests: ArtifactCapabilityRequest[] = [];

	public async recheckArtifactAccess(request: ArtifactCapabilityRequest): Promise<ArtifactResult<ArtifactCapabilityDecision>> {
		this.requests.push(request);
		return {
			ok: true,
			value: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				decision: this.decision,
				...(this.decision === "allow" ? { receiptId: createRuntimeId("receipt", `access-${this.requests.length}`) } : {}),
			},
		};
	}
}

class MemoryAccessLog implements ArtifactAccessLogPort {
	entries: ArtifactAccessLogEntry[] = [];
	fail = false;

	public async append(entry: ArtifactAccessLogEntry): Promise<ArtifactResult<void>> {
		if (this.fail) return { ok: false, error: { code: "durable_write_failed", message: "audit unavailable", retryable: true } };
		this.entries.push(entry);
		return { ok: true, value: undefined };
	}
}

describe("artifact access", () => {
	it("rechecks capability on every read and never treats ask as allow", async () => {
		const harness = await createArtifactHarness();
		try {
			const request = harness.request("access");
			valueOf(await harness.repository.write(request));
			const gateway = new FakeGateway();
			const accessLog = new MemoryAccessLog();
			const service = new ArtifactAccessService({
				cas: harness.cas,
				metadata: harness.metadata,
				gateway,
				accessLog,
				keyProvider: harness.keyProvider,
				clock: () => new Date(NOW),
			});
			const readRequest = {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				artifactId: request.artifactId,
				principalId: request.principalId,
				sessionId: request.source.sessionId,
				workspaceId: request.source.workspaceId,
				capability: "repository_read" as const,
			};
			expect(Buffer.from(valueOf(await service.read(readRequest)).content).toString("utf8")).toContain("visible output");
			expect(Buffer.from(valueOf(await service.read(readRequest)).content).toString("utf8")).toContain("visible output");
			expect(gateway.requests).toHaveLength(2);

			gateway.decision = "ask";
			expect(await service.read(readRequest)).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
			expect(accessLog.entries.at(-1)?.decision).toBe("denied");
		} finally {
			await harness.cleanup();
		}
	});

	it("decrypts forensic content only after recheck and durable purpose logging", async () => {
		const harness = await createArtifactHarness();
		try {
			const request = {
				...harness.request("forensic-access"),
				content: "raw incident token=top-secret",
				redaction: "forensic" as const,
				forensicAuthorization: { approvalId: createRuntimeId("approval", "forensic-access"), purpose: "capture evidence" },
			};
			valueOf(await harness.repository.write(request));
			const gateway = new FakeGateway();
			const accessLog = new MemoryAccessLog();
			const service = new ArtifactAccessService({
				cas: harness.cas,
				metadata: harness.metadata,
				gateway,
				accessLog,
				keyProvider: harness.keyProvider,
				clock: () => new Date(NOW),
			});
			const base = {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				artifactId: request.artifactId,
				principalId: request.principalId,
				sessionId: request.source.sessionId,
				workspaceId: request.source.workspaceId,
				capability: "repository_read" as const,
			};
			expect(await service.read(base)).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
			const read = valueOf(await service.read({ ...base, forensicPurpose: "security review" }));
			expect(Buffer.from(read.content).toString("utf8")).toBe(request.content);
			expect(gateway.requests.at(-1)?.operation).toBe("read_forensic");
			expect(accessLog.entries.at(-1)).toMatchObject({ operation: "read_forensic", decision: "allowed" });
			expect(accessLog.entries.at(-1)?.purposeDigest).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed when the forensic access audit log cannot be written", async () => {
		const harness = await createArtifactHarness();
		try {
			const request = {
				...harness.request("audit-fail"),
				content: "raw",
				redaction: "forensic" as const,
				forensicAuthorization: { approvalId: createRuntimeId("approval", "audit-fail"), purpose: "capture" },
			};
			valueOf(await harness.repository.write(request));
			const accessLog = new MemoryAccessLog();
			accessLog.fail = true;
			const service = new ArtifactAccessService({
				cas: harness.cas,
				metadata: harness.metadata,
				gateway: new FakeGateway(),
				accessLog,
				keyProvider: harness.keyProvider,
			});
			expect(
				await service.read({
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					artifactId: request.artifactId,
					principalId: request.principalId,
					sessionId: request.source.sessionId,
					workspaceId: request.source.workspaceId,
					capability: "repository_read",
					forensicPurpose: "security review",
				}),
			).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
		} finally {
			await harness.cleanup();
		}
	});

	it("coordinates read leases with deletion reservations", () => {
		const leases = new ArtifactReadLeaseRegistry();
		const releaseRead = leases.acquire("digest");
		expect(releaseRead).toBeTypeOf("function");
		expect(leases.reserveDeletion("digest")).toBeUndefined();
		releaseRead?.();
		const releaseDelete = leases.reserveDeletion("digest");
		expect(releaseDelete).toBeTypeOf("function");
		expect(leases.acquire("digest")).toBeUndefined();
		releaseDelete?.();
		expect(leases.acquire("digest")).toBeTypeOf("function");
	});

	it("blocks quarantined Artifacts at dangerous sinks before calling the Gateway", async () => {
		const harness = await createArtifactHarness();
		try {
			const request = harness.request("taint-access");
			valueOf(await harness.repository.write(request));
			const gateway = new FakeGateway();
			const accessLog = new MemoryAccessLog();
			const service = new ArtifactAccessService({
				cas: harness.cas,
				metadata: harness.metadata,
				gateway,
				accessLog,
				keyProvider: harness.keyProvider,
				clock: () => new Date(NOW),
			});
			const denied = await service.read({
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				artifactId: request.artifactId,
				principalId: request.principalId,
				sessionId: request.source.sessionId,
				workspaceId: request.source.workspaceId,
				capability: "process",
				targetSink: "shell",
			});
			expect(denied).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
			expect(gateway.requests).toHaveLength(0);
			expect(accessLog.entries).toEqual([expect.objectContaining({ decision: "denied" })]);
		} finally {
			await harness.cleanup();
		}
	});
});
