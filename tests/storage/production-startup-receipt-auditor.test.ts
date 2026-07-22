import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import { createProductionStartupExternalReceiptAuditor } from "../../src/storage/production-startup-receipt-auditor.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(seed: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `runledger-startup-auditor-${seed}-`));
	roots.push(root);
	return root;
}

async function createAuditor(stateRoot: string): Promise<void> {
	const identity = createLocalIdentityContext();
	await createProductionStartupExternalReceiptAuditor({
		stateRoot,
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
	});
}

describe("production startup receipt auditor state root", () => {
	it("requires a pre-existing private root and creates children only after validation", async () => {
		const parent = await fixtureRoot("missing");
		const stateRoot = join(parent, "missing-state");

		await expect(createAuditor(stateRoot)).rejects.toThrow();
		await expect(lstat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(parent)).toEqual([]);
	});

	it("rejects broad root permissions without chmod or child-store side effects", async () => {
		const parent = await fixtureRoot("mode");
		const stateRoot = join(parent, "state");
		await mkdir(stateRoot, { mode: 0o700 });
		await chmod(stateRoot, 0o755);

		await expect(createAuditor(stateRoot)).rejects.toThrow("private");
		expect((await lstat(stateRoot)).mode & 0o077).toBe(0o055);
		expect(await readdir(stateRoot)).toEqual([]);
	});

	it("rejects a symlink ancestor before writing into its target", async () => {
		const parent = await fixtureRoot("ancestor");
		const targetParent = join(parent, "target");
		await mkdir(targetParent, { mode: 0o700 });
		const alias = join(parent, "alias");
		await symlink(targetParent, alias);
		const escapedState = join(targetParent, "missing-state");

		await expect(createAuditor(join(alias, "missing-state"))).rejects.toThrow();
		await expect(lstat(escapedState)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(targetParent)).toEqual([]);

		const existingState = join(targetParent, "existing-state");
		await mkdir(existingState, { mode: 0o700 });
		await expect(createAuditor(join(alias, "existing-state"))).rejects.toThrow();
		expect(await readdir(existingState)).toEqual([]);
	});
});
