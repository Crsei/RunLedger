import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { builtinHarnessProfiles, projectHarnessTools } from "../../../src/runtime/harness-profiles/index.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { productionSessionTools } from "../../../src/runtime/session-runtime/domain.ts";

const MINIMAL_TOOL_MANIFEST_DIGEST = "3325e5598de3f84582ef89c65532a6c969355c3eb4821bd19c4529ea7bdacafc";

function inertExecutionEnv(cwd: string): ExecutionEnv {
	const unavailable = async (): Promise<never> => { throw new Error("not executed by projection test"); };
	return {
		cwd,
		fs: {
			readFile: unavailable,
			writeFile: unavailable,
			stat: unavailable,
			readdir: unavailable,
			mkdir: unavailable,
			rm: unavailable,
			rename: unavailable,
		},
		shell: { exec: unavailable },
	};
}

function minimalDescriptor() {
	return builtinHarnessProfiles()[1]!;
}

describe("Harness Profile tool projection", () => {
	it("projects minimal@2 to the same governed bash descriptor without edit", () => {
		const tools = productionSessionTools("/workspace", inertExecutionEnv("/workspace"));
		const legacy = projectHarnessTools(minimalDescriptor(), tools);
		const shell = projectHarnessTools(builtinHarnessProfiles().find((profile) => profile.id === "minimal" && profile.version === 2)!, tools);
		expect(shell.tools.map((tool) => tool.name)).toEqual(["bash"]);
		expect(shell.tools[0]!.parameters).toEqual(legacy.tools[0]!.parameters);
	});
	it("pins the minimal@1 ordered provider manifest and removes background handles", () => {
		const tools = productionSessionTools("/workspace", inertExecutionEnv("/workspace"));
		const projected = projectHarnessTools(minimalDescriptor(), tools);
		expect(projected.tools.map((tool) => tool.name)).toEqual(["bash", "edit"]);
		expect(projected.manifestDigest.digest).toBe(MINIMAL_TOOL_MANIFEST_DIGEST);
		expect(projected.tools[0]!.parameters).toHaveProperty("properties");
		expect(projected.tools[0]!.parameters).not.toHaveProperty("properties.run_in_background");
	});

	it("fails closed when an allowlisted governed tool is missing or duplicated", () => {
		const tools = productionSessionTools("/workspace", inertExecutionEnv("/workspace"));
		expect(() => projectHarnessTools(minimalDescriptor(), tools.filter((tool) => tool.name !== "edit")))
			.toThrow(/governed tool must exist exactly once for minimal@1: edit/u);
		const bash = tools.find((tool) => tool.name === "bash")!;
		expect(() => projectHarnessTools(minimalDescriptor(), [...tools, bash]))
			.toThrow(/governed tool must exist exactly once for minimal@1: bash/u);
	});

	it("fails closed before a model call when an allowlisted schema drifts in place", () => {
		const tools = productionSessionTools("/workspace", inertExecutionEnv("/workspace"));
		const drifted = tools.map((tool) => tool.name === "edit"
			? { ...tool, parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }) }
			: tool);
		expect(() => projectHarnessTools(minimalDescriptor(), drifted))
			.toThrow(/minimal@1 tool manifest drift/u);
	});
});
