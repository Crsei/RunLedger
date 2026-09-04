import { describe, expect, it } from "vitest";
import { builtinPermissionPresets } from "../../src/security/config/presets.ts";
import { resolveSecuritySnapshot } from "../../src/security/config/resolver.ts";
import { parseSecurityConfigLayer } from "../../src/security/config/schema.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";

function layer(source: "managed" | "project" | "user" | "cli", document: unknown) {
	const parsed = parseSecurityConfigLayer(source, JSON.stringify(document));
	if (!parsed.ok) throw new Error(parsed.error.message);
	return parsed.value;
}

function resolve(document: unknown) {
	return resolveSecuritySnapshot({
		layers: [layer("user", document)],
		workspaceRoot: "/repo",
		tempRoot: "/tmp/runledger",
		createdAt: "2026-09-02T00:00:00.000Z",
	});
}

describe("builtin permission presets", () => {
	it("defines the three TUI presets as complete immutable policy combinations", () => {
		expect(builtinPermissionPresets()).toEqual([
			expect.objectContaining({
				id: "workspace-write",
				label: "ask_for_approval",
				reviewer: "user",
				requiresExplicitConfirmation: false,
				profile: expect.objectContaining({
					filesystemMode: "workspace-write",
					approvalPolicy: "on-request",
					network: { mode: "review", allowedHosts: [] },
					sandbox: "workspace-write",
				}),
			}),
			expect.objectContaining({
				id: "approve-for-me",
				label: "approve_for_me",
				reviewer: "auto-review",
				requiresExplicitConfirmation: false,
				profile: expect.objectContaining({
					filesystemMode: "workspace-write",
					approvalPolicy: "on-request",
					network: { mode: "review", allowedHosts: [] },
					sandbox: "workspace-write",
				}),
			}),
			expect.objectContaining({
				id: "danger-full-access",
				label: "full_access",
				reviewer: "user",
				requiresExplicitConfirmation: true,
				profile: expect.objectContaining({
					filesystemMode: "unrestricted",
					approvalPolicy: "never",
					network: { mode: "allow", allowedHosts: [] },
					sandbox: "off",
				}),
			}),
		]);
	});

	it("records auto-review in the immutable snapshot instead of changing the approval policy", () => {
		const result = resolve({ profile: "approve-for-me" });
		expect(result).toMatchObject({
			ok: true,
			value: {
				profile: { name: "approve-for-me", approvalPolicy: "on-request", network: { mode: "review" } },
				approvalReviewer: "auto-review",
			},
		});
	});

	it("rejects full-access inheritance and attempts to shadow a builtin profile", () => {
		expect(resolve({
			profile: "team",
			profiles: { team: { extends: "danger-full-access" } },
		})).toMatchObject({ ok: false, error: { code: "invalid_config" } });
		expect(resolve({
			profiles: { "approve-for-me": { extends: "workspace-write" } },
		})).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});

	it("compiles a managed constraints document as a ceiling over a higher-priority CLI selection", () => {
		const managed = layer("managed", {
			managedConstraints: {
				allowedProfiles: ["workspace-write", "approve-for-me"],
				allowedApprovalPolicies: ["on-request"],
				minimumSandbox: "workspace-write",
				forceNetworkDeny: false,
			},
		});
		const cli = layer("cli", { profile: "danger-full-access" });
		const result = resolveSecuritySnapshot({
			layers: [cli, managed],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger",
			createdAt: "2026-09-02T00:00:00.000Z",
		});
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_config", message: expect.stringContaining("forbidden by managed") } });
	});

	it("retains managed constraints in the immutable Host snapshot for settings availability", () => {
		const constraints = {
			allowedProfiles: ["workspace-write", "approve-for-me"],
			allowedApprovalPolicies: ["on-request" as const],
			minimumSandbox: "workspace-write" as const,
			forceNetworkDeny: false,
		};
		const result = resolveSecuritySnapshot({
			layers: [layer("managed", { managedConstraints: constraints }), layer("user", { profile: "workspace-write" })],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger",
			createdAt: "2026-09-02T00:00:00.000Z",
		});

		expect(result).toMatchObject({ ok: true, value: { managedConstraints: constraints } });
	});

	it("rejects a project profile that widens the user security baseline", () => {
		const result = resolveSecuritySnapshot({
			layers: [
				layer("project", { profile: "danger-full-access" }),
				layer("user", { profile: "read-only" }),
			],
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger",
			createdAt: "2026-09-02T00:00:00.000Z",
		});

		expect(result).toMatchObject({
			ok: false,
			error: { code: "invalid_config", message: expect.stringContaining("workspace security") },
		});
	});

	it("lets Ask for approval edit ordinary workspace files but asks for a workspace-external write", () => {
		const result = resolve({ profile: "workspace-write" });
		if (!result.ok) throw new Error(result.error.message);
		const engine = new PermissionEngine();

		expect(engine.evaluate([{ kind: "filesystem", operation: "write", path: "src/generated.ts" }], result.value)).toMatchObject({
			decision: "allow",
			requestDecisions: [{ matchedRuleIds: ["builtin-workspace-write"] }],
		});
		expect(engine.evaluate([{ kind: "filesystem", operation: "write", path: "/outside/generated.ts" }], result.value)).toMatchObject({
			decision: "ask",
			requestDecisions: [{ matchedRuleIds: ["builtin-root-boundary-escalation"] }],
		});
		expect(engine.evaluate([{ kind: "filesystem", operation: "write", path: ".git/config" }], result.value)).toMatchObject({
			decision: "deny",
			requestDecisions: [{ matchedRuleIds: ["builtin-protected-path"] }],
		});
	});

	it("routes an Approve for me workspace-external write back to exact user approval", () => {
		const result = resolve({ profile: "approve-for-me" });
		if (!result.ok) throw new Error(result.error.message);
		const engine = new PermissionEngine();

		expect(engine.evaluate([{ kind: "filesystem", operation: "write", path: "/outside/generated.ts" }], result.value)).toMatchObject({
			decision: "ask",
			requestDecisions: [{ matchedRuleIds: ["builtin-root-boundary-escalation"] }],
		});
	});
});
