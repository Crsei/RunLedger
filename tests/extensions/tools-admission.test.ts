import { describe, expect, it } from "vitest";
import { admitExtensionTools, resolveActiveToolSelection, sanitizeExtensionRuntimeName } from "../../src/extensions/tools/admission.ts";
import type { ExtensionToolPackage } from "../../src/extensions/tools/admission.ts";
import type { AgentToolResult } from "../../src/runtime/types.ts";

const digest = "a".repeat(64);

function pkg(overrides: Partial<ExtensionToolPackage> = {}): ExtensionToolPackage {
	return {
		packageId: "sample@local",
		digest,
		generation: 3,
		declaredTools: ["sample_search"],
		tools: [{ name: "sample_search", description: "searches", parameters: { type: "object", properties: { query: { type: "string" } } }, approvalClass: "read-only" }],
		...overrides,
	};
}

const echoInvoker = async (): Promise<AgentToolResult<unknown>> => ({ content: [{ type: "text", text: "ok" }], details: { ok: true } });

function admit(overrides: Parameters<typeof admitExtensionTools>[0] extends never ? never : Partial<Parameters<typeof admitExtensionTools>[0]> = {}) {
	return admitExtensionTools({ packages: [pkg()], reservedNames: [], invoke: echoInvoker, ...overrides });
}

describe("extension tool admission", () => {
	it("admits a declared tool with provenance and approval flags", () => {
		const result = admit();
		expect(result.rejected).toEqual([]);
		expect(result.admitted).toHaveLength(1);
		const entry = result.admitted[0];
		expect(entry?.tool.name).toBe("sample_search");
		expect(entry?.tool.label).toContain("sample@local");
		expect(entry?.provenance).toEqual({
			packageId: "sample@local",
			digest,
			generation: 3,
			declaredName: "sample_search",
			runtimeName: "sample_search",
			approvalClass: "read-only",
		});
		expect(entry?.tool.isReadOnly?.()).toBe(true);
		expect(entry?.tool.isConcurrencySafe?.()).toBe(true);
		expect(entry?.tool.isDestructive).toBeUndefined();
	});

	it("marks mutating and destructive tools conservatively", () => {
		const result = admit({
			packages: [pkg({
				declaredTools: ["writer", "dropper"],
				tools: [
					{ name: "writer", description: "writes", parameters: { type: "object" }, approvalClass: "mutating" },
					{ name: "dropper", description: "drops", parameters: { type: "object" }, approvalClass: "destructive" },
				],
			})],
		});
		expect(result.rejected).toEqual([]);
		const writer = result.admitted.find((entry) => entry.tool.name === "writer");
		const dropper = result.admitted.find((entry) => entry.tool.name === "dropper");
		expect(writer?.tool.isReadOnly?.()).toBe(false);
		expect(writer?.tool.isConcurrencySafe?.()).toBe(false);
		expect(dropper?.tool.isDestructive?.()).toBe(true);
		expect(dropper?.tool.isConcurrencySafe?.()).toBe(false);
	});

	it("rejects tools the manifest did not declare", () => {
		const result = admit({ packages: [pkg({ declaredTools: [] })] });
		expect(result.admitted).toEqual([]);
		expect(result.rejected).toEqual([{
			packageId: "sample@local",
			name: "sample_search",
			code: "capability_not_declared",
			message: "manifest does not declare capability for tool sample_search",
		}]);
	});

	it("rejects stdlib collisions instead of shadowing them", () => {
		const result = admit({
			packages: [pkg({ declaredTools: ["read"], tools: [{ name: "read", description: "x", parameters: { type: "object" }, approvalClass: "read-only" }] })],
			reservedNames: ["read", "bash", "grep"],
		});
		expect(result.admitted).toEqual([]);
		expect(result.rejected[0]?.code).toBe("runtime_name_reserved");
	});

	it("resolves cross-extension name conflicts deterministically by package order", () => {
		const first = pkg({ packageId: "alpha@local" });
		const second = pkg({ packageId: "beta@local" });
		const forward = admit({ packages: [first, second] });
		const reverse = admit({ packages: [second, first] });
		expect(forward.admitted.map((entry) => entry.provenance.packageId)).toEqual(["alpha@local"]);
		expect(forward.rejected).toEqual([{
			packageId: "beta@local",
			name: "sample_search",
			code: "runtime_name_conflict",
			message: "tool name sample_search is already claimed by alpha@local",
		}]);
		expect(reverse.admitted.map((entry) => entry.provenance.packageId)).toEqual(["beta@local"]);
		expect(reverse.rejected[0]?.code).toBe("runtime_name_conflict");
	});

	it("rejects unbounded or unsafe parameter schemas", () => {
		const cases: Array<{ readonly parameters: Record<string, unknown>; readonly code: string }> = [
			{ parameters: { type: "object", $ref: "https://example.test/schema.json" }, code: "schema_keyword_forbidden" },
			{ parameters: { type: "object", properties: { q: { type: "string", pattern: "^(a+)+$" } } }, code: "schema_keyword_forbidden" },
			{ parameters: { type: "object", properties: { q: { type: "string", $defs: {} } } }, code: "schema_keyword_forbidden" },
			{ parameters: { type: "array" }, code: "schema_not_object" },
			{ parameters: { description: "no shape" }, code: "schema_not_object" },
		];
		for (const testCase of cases) {
			const result = admit({
				packages: [pkg({ tools: [{ name: "sample_search", description: "x", parameters: testCase.parameters, approvalClass: "read-only" }] })],
			});
			expect(result.rejected[0]?.code, testCase.code).toBe(testCase.code);
		}
	});

	it("bounds schema size, depth and node count", () => {
		let nested: Record<string, unknown> = { type: "string" };
		for (let index = 0; index < 12; index += 1) nested = { type: "object", properties: { child: nested } };
		const deep = admit({
			packages: [pkg({ tools: [{ name: "sample_search", description: "x", parameters: nested, approvalClass: "read-only" }] })],
		});
		expect(deep.rejected[0]?.code).toBe("schema_oversize");

		const wide = admit({
			packages: [pkg({ tools: [{ name: "sample_search", description: "x", parameters: { type: "object", properties: { blob: "x".repeat(2_048) } }, approvalClass: "read-only" }] })],
			maxToolSchemaBytes: 256,
		});
		expect(wide.rejected[0]?.code).toBe("schema_oversize");
	});

	it("forwards admitted invocations to the injected invoker and never leaks raw errors", async () => {
		const seen: string[] = [];
		const result = admit({
			invoke: async ({ provenance, toolCallId }) => {
				seen.push(`${provenance.packageId}:${toolCallId}`);
				throw new Error("secret path /home/user/.runledger/credential");
			},
		});
		const tool = result.admitted[0]?.tool;
		if (tool === undefined) throw new Error("tool must be admitted");
		const outcome = await tool.execute("call-1", { query: "x" });
		expect(seen).toEqual(["sample@local:call-1"]);
		expect(outcome.isError).toBe(true);
		expect(JSON.stringify(outcome)).not.toContain("/home/user");
		expect(outcome.details).toEqual({ code: "extension_tool_failed", message: "extension tool invocation failed" });
	});

	it("only accepts runtime names that already satisfy the contract", () => {
		expect(sanitizeExtensionRuntimeName("sample_search")).toBe("sample_search");
		expect(sanitizeExtensionRuntimeName(" sample_search ")).toBe("sample_search");
		expect(sanitizeExtensionRuntimeName("9bad")).toBeUndefined();
		expect(sanitizeExtensionRuntimeName("bad name")).toBeUndefined();
		expect(sanitizeExtensionRuntimeName("")).toBeUndefined();
		expect(sanitizeExtensionRuntimeName("x".repeat(65))).toBeUndefined();
	});

	it("keeps setActiveTools an owner decision", () => {
		expect(resolveActiveToolSelection({ requested: ["a", "b"], admittedNames: ["a", "b", "c"] })).toEqual({ ok: true, active: ["a", "b"] });
		expect(resolveActiveToolSelection({ requested: ["a", "a"], admittedNames: ["a"] })).toEqual({ ok: true, active: ["a"] });
		expect(resolveActiveToolSelection({ requested: ["a", "ghost"], admittedNames: ["a"] })).toEqual({ ok: false, code: "unknown_tool", names: ["a", "ghost"] });
		expect(resolveActiveToolSelection({ requested: ["a", "b"], admittedNames: ["a", "b"], maxActive: 1 })).toEqual({ ok: false, code: "selection_limit_exceeded", names: ["b"] });
	});
});
