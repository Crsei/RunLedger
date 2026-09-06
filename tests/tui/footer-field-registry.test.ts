import { describe, expect, it } from "vitest";
import {
	createDefaultFooterFieldRegistry,
	fitProjectedFooterRows,
	FooterFieldRegistry,
	type FooterFieldDefinition,
	type FooterSnapshot,
} from "../../src/tui/footer/field-registry.ts";
import { applyUsageObservation, createUsageAccumulator, usageSnapshot } from "../../src/runtime/usage/index.ts";

const snapshot: FooterSnapshot = {
	nowMs: 1_000,
	isStreaming: false,
	modelId: "deepseek-v4-pro",
	queue: { steering: 0, followUp: 0 },
};

function field(id: string, order: number, text = id): FooterFieldDefinition {
	return {
		id,
		row: "identity",
		order,
		accent: "metadata",
		project: () => text,
	};
}

describe("FooterFieldRegistry", () => {
	it.each([80, 143])("preserves the active mode at %i columns before optional tool details", (width) => {
		const registry = createDefaultFooterFieldRegistry();
		const projected = registry.project({ ...snapshot, agentMode: "minimal", toolsSummary: "shell", workspaceDisplayAbsolutePath: "/very/long/workspace/path/that/must/compress", permissionProfile: "workspace-write" });
		const fields = fitProjectedFooterRows(projected.rows, width).flatMap((row) => row.fields);
		expect(fields.find((entry) => entry.id === "identity.mode")?.segment.text).toBe("Mode: minimal");
		if (width === 143) expect(fields.find((entry) => entry.id === "identity.tools")?.segment.text).toBe("Tools: shell");
	});

	it("orders registered fields by order and registration sequence", () => {
		const registry = new FooterFieldRegistry();
		expect(registry.register(field("identity.model", 20)).ok).toBe(true);
		expect(registry.register(field("identity.path", 10)).ok).toBe(true);
		expect(registry.register(field("identity.thread", 20)).ok).toBe(true);

		expect(registry.list("identity").map((entry) => entry.definition.id)).toEqual([
			"identity.path",
			"identity.model",
			"identity.thread",
		]);
		expect(registry.project(snapshot).rows[0]?.fields.map((entry) => entry.id)).toEqual([
			"identity.path",
			"identity.model",
			"identity.thread",
		]);
	});

	it("rejects duplicate and invalid definitions without replacing the first field", () => {
		const registry = new FooterFieldRegistry();
		expect(registry.register(field("identity.model", 10))).toMatchObject({ ok: true });
		expect(registry.register(field("identity.model", 0, "replacement"))).toEqual({
			ok: false,
			code: "duplicate_field",
		});
		expect(registry.register(field("", 0))).toEqual({ ok: false, code: "invalid_definition" });

		expect(registry.project(snapshot).rows[0]?.fields[0]?.segment.text).toBe("identity.model");
	});

	it("notifies revisions and returns an idempotent unregister handle", () => {
		const registry = new FooterFieldRegistry();
		const revisions: number[] = [];
		const unsubscribe = registry.subscribe((revision) => revisions.push(revision));
		const registered = registry.register(field("identity.model", 10));
		if (!registered.ok) throw new Error("registration failed");

		expect(registered.unregister()).toBe(true);
		expect(registered.unregister()).toBe(false);
		unsubscribe();
		registry.register(field("identity.path", 10));

		expect(revisions).toEqual([1, 2]);
		expect(registry.revision).toBe(3);
	});

	it("isolates projection failures and disposes one instance without affecting another", () => {
		const first = new FooterFieldRegistry();
		const second = new FooterFieldRegistry();
		first.register(field("identity.good", 10, "good"));
		first.register({
			...field("identity.bad", 20),
			project: () => { throw new Error("secret details"); },
		});
		second.register(field("identity.other", 10, "other"));

		const projected = first.project(snapshot);
		expect(projected.rows[0]?.fields.map((entry) => entry.segment.text)).toEqual(["good", "[footer:err]"]);
		expect(projected.errors).toEqual([{ fieldId: "identity.bad", code: "projection_failed" }]);

		first.dispose();
		expect(first.list()).toEqual([]);
		expect(first.register(field("identity.after", 10))).toEqual({ ok: false, code: "registry_disposed" });
		expect(second.project(snapshot).rows[0]?.fields[0]?.segment.text).toBe("other");
	});

	it("registers the complete built-in activity, identity, and usage field catalog", () => {
		let accumulator = createUsageAccumulator();
		accumulator = applyUsageObservation(accumulator, {
			id: "assistant:1",
			usage: {
				input: 12_300,
				output: 1_400,
				cacheRead: 8_000,
				cacheWrite: 512,
				totalTokens: 22_212,
				cost: { input: 0.03, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
				reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
			},
			durationMs: 2_000,
			timingSource: "provider",
			status: "completed",
		});
		const registry = createDefaultFooterFieldRegistry();
		const projection = registry.project({
			nowMs: 20_000,
			isStreaming: false,
			modelId: "deepseek-v4-pro",
			providerId: "deepseek",
			thinkingLevel: "high",
			workspaceDisplayAbsolutePath: "/home/alice/RunLedger",
			gitBranchLabel: "feature/footer-registry",
			planProgress: { completed: 2, total: 5 },
			threadLabel: "Footer registry",
			queue: { steering: 1, followUp: 2 },
			usage: usageSnapshot(accumulator, { usedTokens: 18_200, contextWindow: 128_000 }, "idle"),
		});

		expect(projection.rows.map((row) => row.row)).toEqual(["activity", "identity", "usage"]);
		expect(projection.rows[0]?.fields.map((entry) => entry.segment.text)).toEqual(["queue:s1/f2"]);
		expect(projection.rows[1]?.fields.map((entry) => entry.id)).toEqual([
			"identity.path",
			"identity.branch",
			"identity.model",
			"identity.plan",
			"identity.thread",
		]);
		expect(projection.rows[2]?.fields.map((entry) => entry.segment.text)).toEqual([
			"in 12.3k",
			"out 1.4k",
			"cache-read 8.0k",
			"cache-write 512",
			"hit 38.4%",
			"700.0 tok/s",
			"$0.03",
			"ctx 18.2k/128.0k (14.2%)",
		]);
		for (const width of [78, 141]) {
			const fitted = fitProjectedFooterRows(projection.rows, width);
			expect(fitted.find((row) => row.row === "usage")?.fields.find((field) => field.id === "usage.cost")?.segment.text).toBe("$0.03");
		}
	});

	it("drops optional usage fields by descriptor priority rather than rendered text", () => {
		const registry = new FooterFieldRegistry();
		for (const definition of [
			{ ...field("usage.cost", 10, "费用 0.03"), row: "usage" as const, dropPriority: 10 },
			{ ...field("usage.hit", 20, "命中 38.4%"), row: "usage" as const, dropPriority: 20 },
			{ ...field("usage.output", 30, "输出 1.4k"), row: "usage" as const },
			{ ...field("usage.rate", 40, "速度 700.0"), row: "usage" as const },
		]) registry.register(definition);
		const fitted = fitProjectedFooterRows(registry.project(snapshot).rows, 23);

		expect(fitted[0]?.fields.map((entry) => entry.id)).toEqual(["usage.output", "usage.rate"]);
	});
});
