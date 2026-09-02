import { describe, expect, it, vi } from "vitest";
import stripAnsi from "strip-ansi";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { PermissionsWorkflow } from "../../../src/tui/permissions/workflow.ts";
import { loadTheme } from "../../../src/tui/theme/theme.ts";
import type { Component } from "../../../src/tui/index.ts";

describe("PermissionsWorkflow", () => {
	it("shows Host-projected unavailable presets as disabled", async () => {
		const sourceDigest = runtimeDigest({ profile: "workspace-write" });
		let overlay: Component | undefined;
		const workflow = new PermissionsWorkflow({
			controller: {
				supports: (operation) => operation === "security.settings.inspect" || operation === "security.settings.update" || operation === "session.security.inspect",
				querySessionDomain: async (operation) => operation === "session.security.inspect"
					? {
						ok: true as const,
						status: "ok" as const,
						operation,
						domainRevision: 5,
						value: {
							presetAvailability: [
								{ id: "workspace-write", state: "unavailable", reason: "sandbox_capability_unavailable" },
								{ id: "approve-for-me", state: "unavailable", reason: "sandbox_capability_unavailable" },
								{ id: "danger-full-access", state: "available" },
							],
						},
					}
					: {
						ok: true as const,
						status: "ok" as const,
						operation,
						domainRevision: 5,
						value: { scope: "user", document: { profile: "workspace-write" }, sourceDigest, appliesTo: "new_sessions", editable: true },
					},
				commandSessionDomain: async () => ({ ok: false as const, status: "unavailable" as const, code: "unused", operation: "security.settings.update" }),
			},
			theme: loadTheme("dark"),
			showOverlay: (component) => { overlay = component; },
			closeOverlay: () => { overlay = undefined; },
			showNotice: () => undefined,
			requestRender: () => undefined,
			nextRequest: () => ({ correlationId: "permission-correlation", effectId: "permission-effect" }),
		});

		await workflow.open();
		const cards = stripAnsi(overlay?.render(120).join("\n") ?? "");
		expect(cards).toContain("Unavailable: sandbox_capability_unavailable");
	});

	it("renders the three system cards and requires confirmation before saving Full Access", async () => {
		const sourceDigest = runtimeDigest({ profile: "workspace-write" });
		let overlay: Component | undefined;
		const command = vi.fn(async () => ({
			ok: true as const,
			status: "ok" as const,
			operation: "security.settings.update",
			domainRevision: 5,
			value: { scope: "user", document: { profile: "danger-full-access" }, sourceDigest, appliesTo: "new_sessions" },
		}));
		const workflow = new PermissionsWorkflow({
			controller: {
				supports: () => true,
				querySessionDomain: async () => ({
					ok: true as const,
					status: "ok" as const,
					operation: "security.settings.inspect",
					domainRevision: 5,
					value: { scope: "user", document: { profile: "workspace-write" }, sourceDigest, appliesTo: "new_sessions", editable: true },
				}),
				commandSessionDomain: command,
			},
			theme: loadTheme("dark"),
			showOverlay: (component) => { overlay = component; },
			closeOverlay: () => { overlay = undefined; },
			showNotice: () => undefined,
			requestRender: () => undefined,
			nextRequest: () => ({ correlationId: "permission-correlation", effectId: "permission-effect" }),
		});

		await workflow.open();
		const cards = stripAnsi(overlay?.render(120).join("\n") ?? "");
		expect(cards).toContain("Ask for approval (current)");
		expect(cards).toContain("Approve for me");
		expect(cards).toContain("Full Access");
		overlay?.handleInput?.("down");
		overlay?.handleInput?.("down");
		overlay?.handleInput?.("enter");

		const confirmation = stripAnsi(overlay?.render(120).join("\n") ?? "");
		expect(confirmation).toContain("Confirm Full Access");
		expect(confirmation).toContain("outside this workspace");
		overlay?.handleInput?.("enter");
		await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
		expect(command).toHaveBeenCalledWith("security.settings.update", {
			scope: "user",
			expectedSourceDigest: sourceDigest,
			document: { profile: "danger-full-access", approvalReviewer: "user" },
		}, { correlationId: "permission-correlation", effectId: "permission-effect", expectedRevision: 5 });
	});

	it("directs a stale permission update back to /permissions", async () => {
		const sourceDigest = runtimeDigest({ profile: "workspace-write" });
		let overlay: Component | undefined;
		const notices: string[] = [];
		const workflow = new PermissionsWorkflow({
			controller: {
				supports: () => true,
				querySessionDomain: async () => ({
					ok: true as const,
					status: "ok" as const,
					operation: "security.settings.inspect",
					domainRevision: 5,
					value: { scope: "user", document: { profile: "workspace-write" }, sourceDigest, appliesTo: "new_sessions", editable: true },
				}),
				commandSessionDomain: async () => ({ ok: false as const, status: "stale" as const, code: "revision_conflict", operation: "security.settings.update", currentRevision: 6 }),
			},
			theme: loadTheme("dark"),
			showOverlay: (component) => { overlay = component; },
			closeOverlay: () => { overlay = undefined; },
			showNotice: (message) => { notices.push(message); },
			requestRender: () => undefined,
			nextRequest: () => ({ correlationId: "permission-correlation", effectId: "permission-effect" }),
		});

		await workflow.open();
		overlay?.handleInput?.("enter");
		await vi.waitFor(() => expect(notices).toContain("Permissions changed elsewhere. Reopen /permissions and try again."));
	});
});
