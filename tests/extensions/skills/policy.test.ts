/**
 * P3：user/workspace skills provider policy 合并（只允许收窄）。
 *
 * 规则（02 计划 §8.1）：user `enabled=false` 总闸；workspace 不能反转 user
 * false；未知 provider ID 保留 diagnostic 不自动运行；workspace `true` 不能
 * 覆盖 user `false`。
 */

import { describe, expect, it } from "vitest";
import { resolveSkillsPolicy, KNOWN_SKILL_PROVIDER_IDS } from "../../../src/extensions/skills/policy.ts";
import type { SkillsSettings } from "../../../src/storage/settings-manager.ts";

function providers(entries: readonly [string, boolean][]): Record<string, boolean> {
	return Object.fromEntries(entries);
}

describe("skills provider policy merge", () => {
	it("defaults to all providers enabled and master on when no settings exist", () => {
		const result = resolveSkillsPolicy(undefined, undefined);
		expect(result.masterEnabled).toBe(true);
		expect(result.providerEnabled.size).toBe(0);
		expect(result.diagnostics).toEqual([]);
	});

	it("keeps only known provider IDs and reports unknown ones without running them", () => {
		const result = resolveSkillsPolicy({ providers: providers([["runledger-user", false], ["omp-user", true], ["unknown-provider", true]]) }, undefined);
		expect(result.providerEnabled.get("runledger-user")).toBe(false);
		expect(result.providerEnabled.has("omp-user")).toBe(false);
		expect(result.providerEnabled.has("unknown-provider")).toBe(false);
		expect(result.diagnostics.map((item) => item.code)).toEqual(["skill.policy_unknown_provider", "skill.policy_unknown_provider"]);
	});

	it("lets workspace narrow a user-enabled provider but not re-enable a user-disabled one", () => {
		const narrowed = resolveSkillsPolicy({ providers: providers([["runledger-user", true]]) }, { providers: providers([["runledger-user", false]]) });
		expect(narrowed.providerEnabled.get("runledger-user")).toBe(false);
		expect(narrowed.diagnostics).toEqual([]);

		const blocked = resolveSkillsPolicy({ providers: providers([["runledger-user", false]]) }, { providers: providers([["runledger-user", true]]) });
		expect(blocked.providerEnabled.get("runledger-user")).toBe(false);
		expect(blocked.diagnostics.map((item) => item.code)).toEqual(["skill.policy_workspace_cannot_reopen"]);
	});

	it("treats user enabled=false as the master switch independent of workspace", () => {
		const result = resolveSkillsPolicy({ enabled: false, providers: providers([["runledger-user", true]]) }, { providers: providers([["runledger-workspace", true]]) });
		expect(result.masterEnabled).toBe(false);
		expect(result.providerEnabled.get("runledger-user")).toBe(true);
		expect(result.providerEnabled.get("runledger-workspace")).toBe(true);
	});

	it("exposes the canonical provider ID set for schema validation", () => {
		expect(KNOWN_SKILL_PROVIDER_IDS).toEqual(expect.arrayContaining(["runledger-user", "runledger-workspace", "runledger-plugin", "runledger-repo", "runledger-session", "runledger-builtin"]));
		expect(Object.isFrozen(KNOWN_SKILL_PROVIDER_IDS)).toBe(true);
	});

	it("merges disjoint provider settings from both scopes", () => {
		const result = resolveSkillsPolicy(
			{ providers: providers([["runledger-user", false]]) },
			{ providers: providers([["runledger-workspace", false]]) },
		);
		expect(result.providerEnabled.get("runledger-user")).toBe(false);
		expect(result.providerEnabled.get("runledger-workspace")).toBe(false);
	});
});
