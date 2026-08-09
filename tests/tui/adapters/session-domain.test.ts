import { describe, expect, it, vi } from "vitest";
import { createSessionDomainPort } from "../../../src/tui/adapters/session-domain.ts";

const ref = { generation: 7, effectId: "effect-session", correlationId: "corr-session", signal: new AbortController().signal, authorityGeneration: 11 };

describe("S2 session domain adapter", () => {
	it("projects only canonical SQLite catalog fields and preserves the domain revision", async () => {
		const query = vi.fn(async () => ({
			ok: true as const,
			status: "ok" as const,
			operation: "session.catalog.list",
			domainRevision: 2,
			value: {
				items: [{
					sessionId: "session-a",
					workspaceId: "workspace-a",
					repositoryId: "repository-a",
					status: "paused",
					createdAtMs: 10,
					updatedAtMs: 20,
					headSequence: 4,
					driverRevision: 3,
					current: false,
					title: "must-not-leak",
					cwd: "/native/path",
				}],
			},
		}));
		const port = createSessionDomainPort({ query, command: vi.fn(), supports: () => true });
		const result = await port.list(ref);
		expect(query).toHaveBeenCalledWith("session.catalog.list", {}, { correlationId: "corr-session", effectId: "effect-session" });
		expect(result).toEqual({
			ok: true,
			ref,
			value: {
				kind: "catalog",
				revision: 2,
				items: [{
					sessionId: "session-a",
					workspaceId: "workspace-a",
					repositoryId: "repository-a",
					status: "paused",
					createdAtMs: 10,
					updatedAtMs: 20,
					headSequence: 4,
					driverRevision: 3,
					current: false,
				}],
			},
		});
	});

	it("maps create/resume/fork to typed mutation envelopes and recovery_required to uncertain", async () => {
		const command = vi.fn(async (operation: string) => operation === "session.create"
			? { ok: false as const, status: "recovery_required" as const, code: "recovery_barrier_active", operation, currentRevision: 8 }
			: { ok: true as const, status: "ok" as const, operation, domainRevision: 8, value: { targetSessionId: "session-target" } });
		const port = createSessionDomainPort({ query: vi.fn(), command, supports: () => true });
		await expect(port.create({ ...ref, expectedRevision: 8 })).resolves.toMatchObject({
			ok: false,
			error: { code: "recovery_barrier_active", recoveryRequired: true },
		});
		await expect(port.resume({ ...ref, expectedRevision: 8, targetSessionId: "session-target" })).resolves.toMatchObject({
			ok: true,
			value: { kind: "transition", operation: "resume", targetSessionId: "session-target", catalogRevision: 8 },
		});
		await expect(port.fork({ ...ref, expectedRevision: 8, sourceSessionId: "session-source", expectedSourceHeadSequence: 5 })).resolves.toMatchObject({
			ok: true,
			value: { kind: "transition", operation: "fork", targetSessionId: "session-target", catalogRevision: 8 },
		});
		expect(command).toHaveBeenNthCalledWith(2, "session.resume", { targetSessionId: "session-target" }, { correlationId: "corr-session", effectId: "effect-session", expectedRevision: 8 });
		expect(command).toHaveBeenNthCalledWith(3, "session.fork", { sourceSessionId: "session-source", expectedSourceHeadSequence: 5 }, { correlationId: "corr-session", effectId: "effect-session", expectedRevision: 8 });
	});
});
