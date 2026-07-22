import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills } from "../../src/extensions/skills/discovery.ts";
import { parseSkillDocument } from "../../src/extensions/skills/frontmatter.ts";
import { SkillCatalog } from "../../src/extensions/skills/catalog.ts";
import { renderSkillCatalog } from "../../src/extensions/skills/renderer.ts";
import { SkillToolResolver } from "../../src/extensions/skills/skill-tool.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionSourceRoot } from "../../src/extensions/types.ts";
import { makeExtensionTempDir, NodeTestExtensionStorage, removeExtensionTempDir, TEST_SCOPE } from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await makeExtensionTempDir(label);
	temporaryDirectories.push(path);
	return path;
}

async function writeSkill(root: string, directory: string, name = "release-review", description = "Review a release safely"): Promise<string> {
	const skillRoot = join(root, "skills", directory);
	await mkdir(join(skillRoot, "references"), { recursive: true });
	await mkdir(join(skillRoot, "assets"), { recursive: true });
	await mkdir(join(skillRoot, "scripts"), { recursive: true });
	await writeFile(join(skillRoot, "references", "checklist.md"), "# Checklist\n");
	await writeFile(join(skillRoot, "assets", "fixture.txt"), "asset\n");
	await writeFile(join(skillRoot, "scripts", "unsafe.mjs"), "throw new Error('must not execute');\n");
	await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nuser-invocable: true\ndisable-model-invocation: false\nallowed-tools:\n  - read\n  - bash\nmetadata:\n  owner: release\n---\nFollow the release checklist.\n`);
	return skillRoot;
}

function root(path: string, sourceKey: string, priority = 200): ExtensionSourceRoot {
	return { source: "project", sourceKey, rootPath: path, priority };
}

describe("Skill discovery and on-demand loading", () => {
	it("parses bounded YAML frontmatter and reports unknown fields without executing content", () => {
		const parsed = parseSkillDocument("---\nname: fixture\ndescription: Fixture skill\nunknown: ignored\n---\nBody\n", "/fixture/SKILL.md");
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.frontmatter).toMatchObject({ name: "fixture", userInvocable: true, disableModelInvocation: false });
			expect(parsed.body).toBe("Body\n");
			expect(parsed.diagnostics.map((item) => item.code)).toContain("skill.unknown_field");
		}
		expect(parseSkillDocument("name: fixture", "/fixture/SKILL.md").ok).toBe(false);
	});

	it("discovers metadata/body/assets/scripts as separate facets and keeps untrusted bodies blocked", async () => {
		const parent = await temporary("skills-discovery");
		const extensionRoot = join(parent, ".runledger");
		const skillRoot = await writeSkill(extensionRoot, "release-review");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const initial = await discoverSkills({ roots: [root(extensionRoot, "project:fixture")], scope: TEST_SCOPE, trustStore: trust, storage });
		expect(initial.skills).toHaveLength(1);
		const discovered = initial.skills[0];
		expect(discovered?.descriptor.activation).toBe("blocked");
		expect(discovered?.trustBinding.canonicalPath).toBe(skillRoot);
		expect(discovered?.resourceSet).toMatchObject({ metadata: { role: "metadata" }, body: { role: "body" }, assets: { role: "assets" }, script: { role: "script" } });
		const blocked = await new SkillToolResolver({ catalog: new SkillCatalog(initial.skills), trustStore: trust, principalId: TEST_SCOPE.principalId, storage, currentTools: () => ["read", "write", "bash"] }).load("$release-review");
		expect(blocked).toMatchObject({ ok: false, code: "blocked" });
	});

	it("loads an exact trusted body, intersects allowed tools, and rejects post-snapshot changes", async () => {
		const parent = await temporary("skills-load");
		const extensionRoot = join(parent, ".runledger");
		const skillRoot = await writeSkill(extensionRoot, "release-review");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const untrusted = await discoverSkills({ roots: [root(extensionRoot, "project:fixture")], scope: TEST_SCOPE, trustStore: trust, storage });
		const binding = untrusted.skills[0]?.trustBinding;
		expect(binding).toBeDefined();
		if (!binding) return;
		await trust.grant({ identity: binding.identity, canonicalPath: binding.canonicalPath, binding: binding.binding, principalId: TEST_SCOPE.principalId, scope: "project" });
		const trusted = await discoverSkills({ roots: [root(extensionRoot, "project:fixture")], scope: TEST_SCOPE, trustStore: trust, storage });
		expect(trusted.skills[0]?.descriptor.activation).toBe("ready");
		const resolver = new SkillToolResolver({ catalog: new SkillCatalog(trusted.skills), trustStore: trust, principalId: TEST_SCOPE.principalId, storage, currentTools: () => ["read", "write", "bash"] });
		const loaded = await resolver.load("$release-review deploy production");
		expect(loaded).toMatchObject({ ok: true, value: { trigger: "dollar", argument: "deploy production", allowedTools: ["read", "bash"] } });
		if (loaded.ok) expect(loaded.value.body).toContain("Follow the release checklist");
		await writeFile(join(skillRoot, "SKILL.md"), "---\nname: release-review\ndescription: Changed\n---\nChanged body\n");
		expect(await resolver.load("release-review")).toMatchObject({ ok: false, code: "stale" });
	});

	it("requires qualified identity for ambiguous names and renders a deterministic bounded catalog", async () => {
		const parent = await temporary("skills-ambiguous");
		const first = join(parent, "first");
		const second = join(parent, "second");
		await writeSkill(first, "one", "shared", "A".repeat(300));
		await writeSkill(second, "two", "shared", "B".repeat(300));
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const result = await discoverSkills({ roots: [root(first, "project:first", 100), root(second, "project:second", 200)], scope: TEST_SCOPE, trustStore: trust, storage });
		const catalog = new SkillCatalog(result.skills);
		const ambiguous = catalog.resolve("/shared");
		expect(ambiguous).toMatchObject({ ok: false, code: "ambiguous" });
		if (!ambiguous.ok) expect(ambiguous.candidates).toHaveLength(2);
		const rendered = renderSkillCatalog(result.skills, { maxChars: 180, modelContextChars: 20_000 });
		expect(rendered.length).toBeLessThanOrEqual(180);
		expect(rendered).toContain("skill:project:first:shared");
		expect(rendered).toContain("skill:project:second:shared");
		expect(renderSkillCatalog([...result.skills].reverse(), { maxChars: 180, modelContextChars: 20_000 })).toBe(rendered);
	});
});
