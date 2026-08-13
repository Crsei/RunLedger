/**
 * P1：Skill registry schema 类型的可构造性与只读投影。
 *
 * 这些类型是 P2 SkillRegistry 的输入/输出合同；本测试固定字段方向
 * （development-doc/plugin-mcp-skill-hooks/02 计划 §5），不实现任何
 * 生产行为。SkillRegistrySnapshot 必须能 Object.freeze 且只含 descriptor/
 * diagnostics（无进程、无函数、无 client）。
 */

import { describe, expect, it } from "vitest";
import type { SkillDescriptor, SkillTrustBinding } from "../../../src/extensions/skills/types.ts";
import type { SkillDiscoveryObservation, SkillProviderStatus, SkillRegistrySnapshot } from "../../../src/extensions/skills/registry.ts";
import { extensionDiagnostic } from "../../../src/extensions/diagnostics.ts";

function binding(): SkillTrustBinding {
	return {
		identity: { resourceId: "resource_a", kind: "skill", qualifiedId: "skill:user:fixture:release-review", version: "1", source: "user", digest: { algorithm: "sha256", digest: "d".repeat(64) } },
		canonicalPath: "/fixture/skills/release-review",
		binding: { rootDigest: "root", manifestDigest: "manifest", configDigest: "config", assetsDigest: "assets", capabilityDigest: "capability", combinedDigest: "combined" },
		principalId: "principal_a",
		receiptId: "receipt_a",
	};
}

describe("P1 Skill registry schema", () => {
	it("constructs a frozen SkillDiscoveryObservation with plugin and external-registry fields", () => {
		const observation: SkillDiscoveryObservation = Object.freeze({
			providerId: "runledger-plugin",
			source: "plugin",
			level: "plugin",
			canonicalRoot: "/fixture/plugin",
			scanKind: "single-skill-directory",
			pluginId: "plugin:user:fixture:fixture-plugin",
			inheritedTrustBinding: binding(),
			sourceRegistry: { locatorDigest: "locator", entryId: "entry-1", declaredEnabled: true },
		});
		expect(observation.providerId).toBe("runledger-plugin");
		expect(observation.level).toBe("plugin");
		expect(observation.sourceRegistry?.declaredEnabled).toBe(true);
		expect(Object.isFrozen(observation)).toBe(true);
	});

	it("constructs a frozen SkillRegistrySnapshot with the four visibility views and no functions", () => {
		const snapshot: SkillRegistrySnapshot = Object.freeze({
			generation: 1,
			digest: "a".repeat(64),
			providers: [],
			all: [],
			active: [],
			modelDiscoverable: [],
			userInvocable: [],
			diagnostics: Object.freeze([extensionDiagnostic("skill.registry_ready", "info", "empty registry", "skill")]),
		});
		expect(snapshot.generation).toBe(1);
		expect(snapshot.diagnostics[0]?.code).toBe("skill.registry_ready");
		expect(Object.isFrozen(snapshot)).toBe(true);
	});

	it("types SkillProviderStatus as an extension of ProviderStatus with skill counts", () => {
		const status: SkillProviderStatus = {
			providerId: "runledger-user",
			displayName: "RunLedger user skills",
			capabilityId: "skills",
			rank: 100,
			defaultEnabled: true,
			effectiveEnabled: true,
			state: "loaded",
			observationCount: 1,
			diagnosticCount: 0,
			candidateCount: 1,
			activeCount: 1,
			failedCount: 0,
		};
		expect(status.providerId).toBe("runledger-user");
		expect(status.candidateCount).toBe(1);
	});

	it("keeps SkillDescriptor assignable to the snapshot all/active views", () => {
		const descriptor = { qualifiedId: "skill:user:fixture:release-review" } as unknown as SkillDescriptor;
		const snapshot: SkillRegistrySnapshot = {
			generation: 1,
			digest: "b".repeat(64),
			providers: [],
			all: [descriptor],
			active: [descriptor],
			modelDiscoverable: [descriptor],
			userInvocable: [descriptor],
			diagnostics: [],
		};
		expect(snapshot.all[0]?.qualifiedId).toBe("skill:user:fixture:release-review");
	});
});
