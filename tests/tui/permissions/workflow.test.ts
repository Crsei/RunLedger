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
				supports: (operation) => operation === "security.settings.inspect" || operation === "session.security.apply" || operation === "session.security.inspect",
				querySessionDomain: async (operation) => operation === "session.security.inspect"
					? {
						ok: true as const,
						status: "ok" as const,
						operation,
						domainRevision: 5,
						value: {
							profile: "workspace-write", securityRevision: 1,
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
						value: { profile: "workspace-write", securityRevision: 1, scope: "user", document: { profile: "workspace-write" }, sourceDigest, appliesTo: "new_sessions", editable: true },
					},
				commandSessionDomain: async () => ({ ok: false as const, status: "unavailable" as const, code: "unused", operation: "session.security.apply" }),
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
			operation: "session.security.apply",
			domainRevision: 5,
			value: { effectiveProfile: "danger-full-access", securityRevision: 2, scope: "user", document: { profile: "danger-full-access" }, sourceDigest, appliesTo: "current_and_new_sessions" },
		}));
		const workflow = new PermissionsWorkflow({
			controller: {
				supports: () => true,
				querySessionDomain: async () => ({
					ok: true as const,
					status: "ok" as const,
					operation: "security.settings.inspect",
					domainRevision: 5,
					value: { profile: "workspace-write", securityRevision: 1, scope: "user", document: { profile: "workspace-write" }, sourceDigest, appliesTo: "new_sessions", editable: true },
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
		const narrowConfirmation = stripAnsi(overlay?.render(80).join("\n") ?? "");
		expect(narrowConfirmation).toContain("System-destructive operations still require one-time confirmation.");
		expect(narrowConfirmation).toContain("Deny rules and policy protections remain active.");
		overlay?.handleInput?.("enter");
		await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
		expect(command).toHaveBeenCalledWith("session.security.apply", {
			scope: "user",
			expectedSourceDigest: sourceDigest,
			expectedSecurityRevision: 1,
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
					value: { profile: "workspace-write", securityRevision: 1, scope: "user", document: { profile: "workspace-write" }, sourceDigest, appliesTo: "new_sessions", editable: true },
				}),
				commandSessionDomain: async () => ({ ok: false as const, status: "stale" as const, code: "revision_conflict", operation: "session.security.apply", currentRevision: 6 }),
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
		await vi.waitFor(() => expect(notices).toContain("Permissions changed elsewhere. Reopen /permissions and try again. (revision_conflict)"));
	});

	it.each([
		{ status: "recovery_required", code: "permission_update_requires_recovery", advice: "/recovery assess" },
		{ status: "recovery_required", code: "permissions_saved_not_applied", advice: "were saved" },
		{ status: "denied", code: "policy_denied", advice: "could not be applied" },
	] as const)("preserves $code and the appropriate recovery advice", async ({ status, code, advice }) => {
		let overlay: Component | undefined;
		const notices: string[] = [];
		const onApplied = vi.fn();
		const workflow = new PermissionsWorkflow({
			controller: {
				supports: () => true,
				querySessionDomain: async (operation) => ({ ok: true, status: "ok", operation, domainRevision: 1, value: {
					profile: "workspace-write", securityRevision: 1, document: {}, sourceDigest: runtimeDigest(null), editable: true,
				} }),
				commandSessionDomain: async () => ({ ok: false, status, code, operation: "session.security.apply" }),
			},
			theme: loadTheme("dark"), showOverlay: (view) => { overlay = view; },
			closeOverlay: () => { overlay = undefined; }, showNotice: (message) => { notices.push(message); },
			requestRender: () => undefined, nextRequest: () => ({ correlationId: "apply", effectId: "apply" }), onApplied,
		});
		await workflow.open();
		overlay?.handleInput?.("down"); overlay?.handleInput?.("down"); overlay?.handleInput?.("enter");
		overlay?.handleInput?.("enter");
		await vi.waitFor(() => expect(notices).toHaveLength(1));
		expect(notices[0]).toContain(code);
		expect(notices[0]).toContain(advice);
		if (status === "recovery_required") expect(notices[0]).toContain("Reconnect");
		expect(onApplied).not.toHaveBeenCalled();
	});
});

describe("active permission UI state", () => {
	it("uses the effective profile, prevents double submission, and preserves a newer approval overlay", async () => {
		let overlay: Component | undefined;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		const nextApproval: Component = { render: () => ["new approval"], invalidate: () => undefined };
		const onApplied = vi.fn();
		const onCancel = vi.fn();
		const command = vi.fn(async () => {
			await barrier;
			overlay = nextApproval;
			return { ok: true as const, status: "ok" as const, operation: "session.security.apply", domainRevision: 1, value: { appliesTo: "current_and_new_sessions", effectiveProfile: "danger-full-access", securityRevision: 2 } };
		});
		const workflow = new PermissionsWorkflow({
			controller: {
				supports: () => true,
				querySessionDomain: async (operation) => ({ ok: true, status: "ok", operation, domainRevision: 1, value: {
					profile: "workspace-write", securityRevision: 1, document: { profile: "danger-full-access" }, sourceDigest: runtimeDigest("saved"), editable: true,
				} }),
				commandSessionDomain: command,
			},
			theme: loadTheme("dark"), showOverlay: (view) => { overlay = view; }, getOverlay: () => overlay,
			closeOverlay: () => { overlay = undefined; }, showNotice: () => undefined, requestRender: () => undefined,
			nextRequest: () => ({ correlationId: "apply", effectId: "apply" }), onApplied,
		});
		await workflow.open(onCancel);
		const rendered = stripAnsi(overlay!.render(120).join("\n"));
		expect(rendered).toContain("Ask for approval (current)");
		expect(rendered).toContain("Saved default: danger-full-access");
		overlay!.handleInput?.("escape");
		expect(onCancel).toHaveBeenCalledTimes(1);
		await workflow.open();
		overlay!.handleInput?.("down"); overlay!.handleInput?.("down"); overlay!.handleInput?.("enter");
		overlay!.handleInput?.("enter"); overlay!.handleInput?.("enter");
		expect(command).toHaveBeenCalledTimes(1);
		release();
		await vi.waitFor(() => expect(onApplied).toHaveBeenCalledWith("danger-full-access"));
		expect(overlay).toBe(nextApproval);
	});
});
