import { describe, expect, it } from "vitest";
import { applySystemPermissionPreset } from "../../../src/tui/permissions/preset-selection.ts";

describe("system permission preset selection", () => {
	it("replaces all top-level widening overrides while retaining custom hardening", () => {
		const selected = applySystemPermissionPreset({
			profile: "danger-full-access",
			approvalPolicy: "never",
			approvalReviewer: "user",
			sandbox: "off",
			network: { mode: "allow", allowedHosts: [] },
			filesystem: {
				readRoots: ["/outside/read"],
				writeRoots: ["/outside/write"],
				denyRead: [".env"],
				denyWrite: ["secrets"],
				protectedPaths: [".git"],
			},
			profiles: { team: { extends: "workspace-write" } },
			rules: [{ id: "deny-push", action: "deny", kind: "shell", pattern: "git push*" }],
			bashAnalyzerMode: "ast",
		}, "approve-for-me");

		expect(selected).toEqual({
			profile: "approve-for-me",
			approvalReviewer: "auto-review",
			filesystem: {
				denyRead: [".env"],
				denyWrite: ["secrets"],
				protectedPaths: [".git"],
			},
			profiles: { team: { extends: "workspace-write" } },
			rules: [{ id: "deny-push", action: "deny", kind: "shell", pattern: "git push*" }],
			bashAnalyzerMode: "ast",
		});
	});

	it("drops allow rules that would widen a system preset", () => {
		const selected = applySystemPermissionPreset({
			profile: "danger-full-access",
			rules: [
				{ id: "allow-network", action: "allow", kind: "network", pattern: "fetch:*" },
				{ id: "ask-network", action: "ask", kind: "network", pattern: "fetch:api.example.com" },
				{ id: "deny-push", action: "deny", kind: "shell", pattern: "git push*" },
			],
		}, "workspace-write");

		expect(selected.rules).toEqual([
			{ id: "ask-network", action: "ask", kind: "network", pattern: "fetch:api.example.com" },
			{ id: "deny-push", action: "deny", kind: "shell", pattern: "git push*" },
		]);
	});
});
