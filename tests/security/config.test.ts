import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadSecurityConfigLayers } from "../../src/security/config/loader.ts";
import { resolveSecuritySnapshot } from "../../src/security/config/resolver.ts";
import { parseSecurityConfigDocument, parseSecurityConfigLayer } from "../../src/security/config/schema.ts";

// resolver 把 workspaceRoot 相对路径按平台规则绝对化,期望值用平台 resolve 生成。
const repo = (relative: string): string => resolve("/repo", relative);

describe("security config", () => {
	it("uses fail-closed workspace defaults and protects runtime metadata", () => {
		const result = resolveSecuritySnapshot({
			layers: [],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger/session",
			createdAt: "2026-08-04T00:00:00.000Z",
		});

		expect(result).toMatchObject({ ok: true, value: {
			profile: {
				name: "workspace-write",
				approvalPolicy: "on-request",
				sandbox: "workspace-write",
				network: { mode: "deny", allowedHosts: [] },
			},
			filesystem: { protectedPaths: [repo(".git"), repo(".runledger")] },
		} });
	});

	it("rejects unknown symbolic paths and exact-schema extensions", () => {
		expect(parseSecurityConfigDocument({ profile: "workspace-write", unexpected: true })).toMatchObject({ ok: false });
		const layer = parseSecurityConfigLayer("managed", JSON.stringify({ filesystem: { writeRoots: [":unknown"] } }));
		expect(layer).toMatchObject({ ok: true });
		if (!layer.ok) return;
		expect(resolveSecuritySnapshot({
			layers: [layer.value],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger/session",
			createdAt: "2026-08-04T00:00:00.000Z",
		})).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});

	it("narrows successful and failed snapshot results without losing filesystem values", () => {
		const validLayer = parseSecurityConfigLayer("project", JSON.stringify({ filesystem: {
			readRoots: ["src"],
			writeRoots: ["out"],
			denyRead: [".env"],
			denyWrite: [".git"],
			protectedPaths: ["private"],
		} }));
		if (!validLayer.ok) throw new Error(validLayer.error.message);
		const valid = resolveSecuritySnapshot({
			layers: [validLayer.value],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger/session",
			createdAt: "2026-08-04T00:00:00.000Z",
		});
		if (!valid.ok) throw new Error(valid.error.message);
		expect(valid.value.filesystem.readRoots).toContain(repo("src"));
		expect(valid.value.filesystem.writeRoots).toContain(repo("out"));

		const invalidLayer = parseSecurityConfigLayer("project", JSON.stringify({ filesystem: { denyWrite: [":unknown"] } }));
		if (!invalidLayer.ok) throw new Error(invalidLayer.error.message);
		const invalid = resolveSecuritySnapshot({
			layers: [invalidLayer.value],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger/session",
			createdAt: "2026-08-04T00:00:00.000Z",
		});
		if (invalid.ok) throw new Error("invalid path unexpectedly resolved");
		expect(invalid.error).toMatchObject({ code: "invalid_config" });
	});

	it("does not silently skip corrupt or unavailable config sources", async () => {
		expect(await loadSecurityConfigLayers([
			{ source: "project", read: async () => ({ status: "available", text: "{" }) },
		])).toMatchObject({ ok: false, error: { retryable: false } });
		expect(await loadSecurityConfigLayers([
			{ source: "managed", read: async () => { throw new Error("offline"); } },
		])).toMatchObject({ ok: false, error: { retryable: true } });
	});

	it("rejects a weaker profile selected under managed constraints", () => {
		const layer = parseSecurityConfigLayer("project", JSON.stringify({ profile: "danger-full-access" }));
		if (!layer.ok) throw new Error("fixture did not parse");
		const result = resolveSecuritySnapshot({
			layers: [layer.value],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger/session",
			createdAt: "2026-08-04T00:00:00.000Z",
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
