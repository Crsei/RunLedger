import { describe, expect, it } from "vitest";
import { GitOperations, type GitCommandPort } from "../../src/worktree/git-operations.ts";
import type { GitCommandRequest, GitCommandResult } from "../../src/worktree/ports.ts";

function broker(responder?: (request: GitCommandRequest) => GitCommandResult): { port: GitCommandPort; requests: GitCommandRequest[] } {
	const requests: GitCommandRequest[] = [];
	return {
		requests,
		port: {
			run: async (request) => {
				requests.push(request);
				return responder?.(request) ?? { stdout: "", stderr: "", exitCode: 0, signaled: false };
			},
		},
	};
}

describe("typed GitOperations", () => {
	it("passes argv arrays to the injected broker and never a shell string", async () => {
		const value = broker();
		const git = new GitOperations(value.port, { managedRoot: "/managed" });
		const result = await git.createDetachedWorktree("/repo", "/managed/repo/task", "a".repeat(40));
		expect(result).toEqual({ ok: true, value: "" });
		expect(value.requests[0]).toMatchObject({ cwd: "/repo", arguments: ["worktree", "add", "--detach", "/managed/repo/task", "a".repeat(40)] });
		expect(value.requests[0]?.arguments).not.toContain("sh");
	});

	it("rejects a create/remove target outside the managed containment root", async () => {
		const value = broker();
		const git = new GitOperations(value.port, { managedRoot: "/managed" });
		expect(await git.createDetachedWorktree("/repo", "/managed-other/task", "a".repeat(40))).toMatchObject({ ok: false, error: { code: "outside_managed_root" } });
		expect(await git.removeWorktree("/repo", "/managed-other/task", false)).toMatchObject({ ok: false, error: { code: "outside_managed_root" } });
		expect(value.requests).toHaveLength(0);
	});

	it("keeps branch creation as explicit typed arguments", async () => {
		const value = broker();
		const git = new GitOperations(value.port, { managedRoot: "/managed" });
		await git.createWorktree("/repo", "/managed/repo/task", "runledger/task", "a".repeat(40));
		expect(value.requests[0]?.arguments).toEqual(["worktree", "add", "--no-track", "-b", "runledger/task", "/managed/repo/task", "a".repeat(40)]);
	});

	it("returns a promise when branch validation rejects before invoking git", () => {
		const value = broker();
		const git = new GitOperations(value.port, { managedRoot: "/managed" });
		const result = git.createWorktree("/repo", "/managed/repo/task", "invalid branch", "a".repeat(40));

		expect(result).toBeInstanceOf(Promise);
		expect(value.requests).toHaveLength(0);
	});
});
