import { describe, expect, it } from "vitest";
import { loadSecurityConfigLayers } from "../../src/security/config/loader.ts";
import { resolveSecuritySnapshot } from "../../src/security/config/resolver.ts";
import { parseSecurityConfigDocument } from "../../src/security/config/schema.ts";

describe("security config", () => {
	it("uses fail-closed workspace defaults and protects runtime metadata", () => {
		const result = resolveSecuritySnapshot({
			layers: [],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger/session",
			createdAt: "2026-07-22T00:00:00.000Z",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.profile).toMatchObject({
			name: "workspace-write",
			approvalPolicy: "on-request",
			sandbox: "workspace-write",
			network: { mode: "deny", allowedHosts: [] },
		});
		expect(result.value.filesystem.protectedPaths).toEqual(["/repo/.git", "/repo/.runledger"]);
	});

	it("honors stronger layers and rejects an unknown symbolic path", () => {
		const loaded = resolveSecuritySnapshot({
			layers: [{
				source: "managed",
				documentDigest: "a".repeat(64),
				document: {
					profile: "read-only",
					filesystem: { readRoots: [":workspace", ":tmp"], writeRoots: [":unknown"] },
				},
			}],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger/session",
			createdAt: "2026-07-22T00:00:00.000Z",
		});

		expect(loaded).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});

	it("does not silently skip a corrupt or unavailable config source", async () => {
		const corrupt = await loadSecurityConfigLayers([{ source: "project", read: async () => ({ status: "available", text: "{" }) }]);
		const unavailable = await loadSecurityConfigLayers([{ source: "managed", read: async () => { throw new Error("offline"); } }]);

		expect(corrupt).toMatchObject({ ok: false, error: { retryable: false } });
		expect(unavailable).toMatchObject({ ok: false, error: { retryable: true } });
	});

	it("enforces exact schema and managed minimums", () => {
		expect(parseSecurityConfigDocument({ profile: "workspace-write", surprise: true })).toMatchObject({ ok: false });
		const result = resolveSecuritySnapshot({
			layers: [{
				source: "project",
				documentDigest: "b".repeat(64),
				document: { profile: "danger-full-access" },
			}],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger/session",
			createdAt: "2026-07-22T00:00:00.000Z",
			constraints: {
				allowedProfiles: ["workspace-write"],
				allowedApprovalPolicies: ["on-request"],
				minimumSandbox: "workspace-write",
				forceNetworkDeny: true,
			},
		});
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});
});
