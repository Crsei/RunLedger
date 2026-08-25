import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createNativeWorkspacePathAdapter } from "../../src/workspace/native/adapters.ts";
import { resolveAdditionalWorkspaceRoots } from "../../src/workspace/additional-roots.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pathAdapter() {
	return createNativeWorkspacePathAdapter("linux", {
		realpath: async (path) => {
			try {
				return await realpath(path);
			} catch {
				return undefined;
			}
		},
	});
}

describe("settings workspace additional roots", () => {
	it("resolves relative settings paths to canonical directories inside the workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "runledger-additional-root-"));
		roots.push(workspace);
		await mkdir(join(workspace, "packages", "shared"), { recursive: true });

		const result = await resolveAdditionalWorkspaceRoots({
			adapter: pathAdapter(),
			workspaceRoot: workspace,
			paths: ["packages/shared"],
		});

		expect(result).toMatchObject({ ok: true, value: [{ requestedPath: "packages/shared", canonicalPath: join(workspace, "packages", "shared") }] });
	});

	it("rejects lexical and canonical symlink escapes", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "runledger-additional-root-"));
		const outside = await mkdtemp(join(tmpdir(), "runledger-additional-outside-"));
		roots.push(workspace, outside);
		await symlink(outside, join(workspace, "escape"));

		const lexicalEscape = await resolveAdditionalWorkspaceRoots({
			adapter: pathAdapter(),
			workspaceRoot: workspace,
			paths: [relative(workspace, outside)],
		});
		const symlinkEscape = await resolveAdditionalWorkspaceRoots({
			adapter: pathAdapter(),
			workspaceRoot: workspace,
			paths: ["escape"],
		});

		expect(lexicalEscape).toMatchObject({ ok: false, error: { code: "cross_root_containment" } });
		expect(symlinkEscape).toMatchObject({ ok: false, error: { code: "cross_root_containment" } });
	});

	it("rejects missing roots instead of treating them as writable candidates", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "runledger-additional-root-"));
		roots.push(workspace);

		const result = await resolveAdditionalWorkspaceRoots({
			adapter: pathAdapter(),
			workspaceRoot: workspace,
			paths: ["missing"],
		});

		expect(result).toMatchObject({ ok: false, error: { code: "invalid_path" } });
	});
});
