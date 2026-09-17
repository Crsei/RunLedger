import { describe, expect, it } from "vitest";
import {
	emptyExtensionRegistry,
	extensionRegistryIdentityDigest,
	validateExtensionRegistry,
} from "../../../src/extensions/host/registration.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../../src/contracts/extensions/registry.ts";

const digest = "b".repeat(64);
const base = { packageId: "sample-plugin@local", digest, hostPid: 4_242, generation: 7 };

function candidate(overrides: Partial<Parameters<typeof validateExtensionRegistry>[0]> = {}) {
	return {
		...base,
		tools: [{ name: "sample_tool", description: "reads", parameters: { type: "object" }, approvalClass: "read-only" as const }],
		commands: [{ name: "sample_command", description: "runs" }],
		flags: [{ name: "sample-flag", description: "toggles", type: "boolean" as const }],
		subscriptions: [{ name: "PreToolUse" as const }],
		limits: EXTENSION_DEFAULT_HOST_LIMITS,
		...overrides,
	};
}

describe("extension host registry validation", () => {
	it("freezes an empty registry with the caller's generation and pid", () => {
		const registry = emptyExtensionRegistry(base);
		expect(registry.generation).toBe(7);
		expect(registry.hostPid).toBe(4_242);
		expect(registry.tools).toEqual([]);
		expect(registry.subscriptions).toEqual([]);
	});

	it("accepts a bounded registry and sorts registrations deterministically", () => {
		const validated = validateExtensionRegistry(candidate({
			tools: [
				{ name: "zebra", description: "z", parameters: {}, approvalClass: "destructive" },
				{ name: "alpha", description: "a", parameters: {}, approvalClass: "mutating" },
			],
		}), { packageId: base.packageId, digest, hostPid: base.hostPid, generation: base.generation });
		expect(validated.ok).toBe(true);
		if (!validated.ok) return;
		expect(validated.snapshot.tools.map((tool) => tool.name)).toEqual(["alpha", "zebra"]);
		expect(Object.isFrozen(validated.snapshot)).toBe(true);
	});

	it("rejects duplicate names instead of silently renaming them", () => {
		const duplicated = validateExtensionRegistry(candidate({
			tools: [
				{ name: "same", description: "a", parameters: {}, approvalClass: "read-only" },
				{ name: "same", description: "b", parameters: {}, approvalClass: "read-only" },
			],
		}), { packageId: base.packageId, digest, hostPid: base.hostPid, generation: base.generation });
		expect(duplicated).toEqual({ ok: false, error: { code: "registry_tool_duplicate", message: "duplicate tool name: same" } });
	});

	it("rejects subscriptions outside the frozen projection whitelist", () => {
		const validated = validateExtensionRegistry(candidate({ subscriptions: [{ name: "ToolCall" as never }] }), {
			packageId: base.packageId,
			digest,
			hostPid: base.hostPid,
			generation: base.generation,
		});
		expect(validated.ok).toBe(false);
		if (!validated.ok) expect(validated.error.code).toBe("registry_subscription_unknown");
	});

	it("enforces per-kind limits and tool schema byte bounds", () => {
		const tools = Array.from({ length: 4 }, (_value, index) => ({ name: `tool-${index}`, description: "x", parameters: {}, approvalClass: "read-only" as const }));
		const limited = validateExtensionRegistry(candidate({ tools }), {
			packageId: base.packageId,
			digest,
			hostPid: base.hostPid,
			generation: base.generation,
			limits: { ...EXTENSION_DEFAULT_HOST_LIMITS, maxRegistrationsPerKind: 2 },
		});
		expect(limited.ok).toBe(false);
		if (!limited.ok) expect(limited.error.code).toBe("registry_limit_exceeded");

		const oversize = validateExtensionRegistry(candidate({
			tools: [{ name: "big", description: "x", parameters: { blob: "x".repeat(2_048) }, approvalClass: "read-only" }],
		}), { packageId: base.packageId, digest, hostPid: base.hostPid, generation: base.generation, maxToolSchemaBytes: 256 });
		expect(oversize.ok).toBe(false);
		if (!oversize.ok) expect(oversize.error.code).toBe("registry_tool_schema_oversize");
	});

	it("rejects a host that lies about its package binding", () => {
		const validated = validateExtensionRegistry(candidate({ digest: "c".repeat(64) }), {
			packageId: base.packageId,
			digest,
			hostPid: base.hostPid,
			generation: base.generation,
		});
		expect(validated).toEqual({ ok: false, error: { code: "registry_identity_mismatch", message: "registry identity does not match the active package binding" } });
	});

	it("derives an identity digest that ignores host pid, generation and arrival order", () => {
		const first = validateExtensionRegistry(candidate({
			tools: [
				{ name: "b", description: "b", parameters: {}, approvalClass: "read-only" },
				{ name: "a", description: "a", parameters: {}, approvalClass: "read-only" },
			],
		}), { packageId: base.packageId, digest, hostPid: base.hostPid, generation: 1 });
		const second = validateExtensionRegistry(candidate({
			tools: [
				{ name: "a", description: "a", parameters: {}, approvalClass: "read-only" },
				{ name: "b", description: "b", parameters: {}, approvalClass: "read-only" },
			],
		}), { packageId: base.packageId, digest, hostPid: 99, generation: 42 });
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.identityDigest).toBe(second.identityDigest);
		expect(first.identityDigest).toBe(extensionRegistryIdentityDigest(first.snapshot));

		const changed = validateExtensionRegistry(candidate({
			tools: [{ name: "a", description: "a", parameters: {}, approvalClass: "mutating" }],
		}), { packageId: base.packageId, digest, hostPid: base.hostPid, generation: 1 });
		expect(changed.ok).toBe(true);
		if (changed.ok) expect(changed.identityDigest).not.toBe(first.identityDigest);
	});
});
