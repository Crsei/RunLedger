import { describe, expect, it } from "vitest";
import { resolveSecuritySnapshot } from "../../src/security/config/resolver.ts";
import { parseSecurityConfigLayer } from "../../src/security/config/schema.ts";

function resolve(text: string) {
	const layer = parseSecurityConfigLayer("project", text);
	if (!layer.ok) return layer;
	return resolveSecuritySnapshot({
		layers: [layer.value],
		workspaceRoot: "/repo",
		tempRoot: "/tmp/runledger",
		createdAt: "2026-08-11T00:00:00.000Z",
	});
}

describe("named permission profile inheritance", () => {
	it("inherits a builtin profile and preserves the selected definition source", () => {
		const result = resolve(JSON.stringify({
			profile: "team",
			profiles: {
				team: {
					extends: "workspace-write",
					approvalPolicy: "untrusted",
					network: { mode: "allowlist", allowedHosts: ["api.example.com"] },
					filesystem: { writeRoots: ["generated"] },
				},
			},
		}));

		expect(result).toMatchObject({
			ok: true,
			value: {
				profile: { name: "team", profileSource: "project", approvalPolicy: "untrusted", filesystemMode: "workspace-write" },
				filesystem: { writeRoots: ["/repo/generated"] },
			},
		});
	});

	it("rejects undefined and cyclic extends chains", () => {
		expect(resolve(JSON.stringify({ profile: "team", profiles: { team: { extends: "missing" } } }))).toMatchObject({ ok: false, error: { code: "invalid_config" } });
		expect(resolve(JSON.stringify({
			profile: "a",
			profiles: { a: { extends: "b" }, b: { extends: "a" } },
		}))).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});
});
