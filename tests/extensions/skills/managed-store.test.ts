import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { ManagedSkillStore } from "../../../src/extensions/skills/managed-store.ts";
import { parseSkillDocument } from "../../../src/extensions/skills/frontmatter.ts";
import { NodeExtensionStorage } from "../../../src/storage/extensions/extension-storage.ts";

async function fixture(): Promise<{
	readonly root: string;
	readonly skillRoot: string;
	readonly store: ManagedSkillStore;
}> {
	const root = await mkdtemp(join(tmpdir(), "runledger-managed-skill-"));
	const layout = buildRunledgerLayout(join(root, "home"), "posix");
	const skillRoot = join(layout.state, "extensions", "user", "skills");
	return {
		root,
		skillRoot,
		store: new ManagedSkillStore({
			storage: new NodeExtensionStorage({ runledgerHome: layout.home }),
			userSkillRoot: skillRoot,
		}),
	};
}

describe("ManagedSkillStore", () => {
	it("atomically creates, updates, and removes only its own canonical user skill", async () => {
		const test = await fixture();
		try {
			expect(await test.store.mutate({ action: "create", name: "release-notes", description: "Draft concise release notes", body: "Use the commit history." }))
				.toEqual({ ok: true, action: "create", name: "release-notes" });
			const skillPath = join(test.skillRoot, "release-notes", "SKILL.md");
			const first = parseSkillDocument(await readFile(skillPath, "utf8"), skillPath);
			expect(first).toMatchObject({ ok: true, frontmatter: { name: "release-notes", metadata: { "runledger.managed": "true" } }, body: "Use the commit history." });

			expect(await test.store.mutate({ action: "update", name: "release-notes", body: "Use the merged PR history." }))
				.toEqual({ ok: true, action: "update", name: "release-notes" });
			expect((await readFile(skillPath, "utf8"))).toContain("Use the merged PR history.");
			expect(await test.store.mutate({ action: "delete", name: "release-notes" }))
				.toEqual({ ok: true, action: "delete", name: "release-notes" });
			expect(await test.store.mutate({ action: "update", name: "release-notes", body: "No longer present." }))
				.toMatchObject({ ok: false, code: "missing" });
		} finally {
			await rm(test.root, { recursive: true, force: true });
		}
	});

	it("does not overwrite or delete an un-managed skill, including one with additional assets", async () => {
		const test = await fixture();
		try {
			const foreign = join(test.skillRoot, "foreign");
			await mkdir(foreign, { recursive: true });
			await writeFile(join(foreign, "SKILL.md"), "---\nname: foreign\ndescription: Foreign skill\n---\nDo not touch.\n");
			await writeFile(join(foreign, "notes.txt"), "kept");
			expect(await test.store.mutate({ action: "update", name: "foreign", body: "overwrite" }))
				.toMatchObject({ ok: false, code: "foreign" });
			expect(await test.store.mutate({ action: "delete", name: "foreign" }))
				.toMatchObject({ ok: false, code: "foreign" });
			expect(await readFile(join(foreign, "notes.txt"), "utf8")).toBe("kept");
		} finally {
			await rm(test.root, { recursive: true, force: true });
		}
	});
});
