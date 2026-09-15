import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { ContractController, ContractTerminal } from "./fixtures/contract-integration.ts";

interface InteractiveHeaderRefs {
	readonly header: { render(width: number): readonly string[] };
}

/** InteractiveMode.refs 是私有字段；这里只读取 header 组件的只读 render 输出。 */
function headerLine(mode: InteractiveMode, width = 120): string {
	const refs = (mode as unknown as { readonly refs: InteractiveHeaderRefs }).refs;
	return refs.header.render(width).join("\n");
}

describe("Session harness profile header", () => {
	it("renders Harness, Permission, and Thinking as separate read-only fields", () => {
		const mode = new InteractiveMode({
			controller: new ContractController({
				selection: { thinkingLevel: "high" },
			}),
			terminal: new ContractTerminal(),
			harnessProfile: { id: "minimal", version: 1 },
			permissionProfile: "workspace-write",
		} as never);
		try {
			const header = headerLine(mode);
			expect(header).toContain("Mode: minimal");
			expect(header).toContain("Harness: minimal@1");
			expect(header).toContain("Permission: workspace-write");
			expect(header).toContain("Thinking: high");
			expect(header).not.toContain("thinking=minimal");
		} finally {
			mode.quit();
		}
	});

	it("omits the Mode badge for the default harness profile", () => {
		const mode = new InteractiveMode({
			controller: new ContractController({ selection: { thinkingLevel: "high" } }),
			terminal: new ContractTerminal(),
			harnessProfile: { id: "standard", version: 2 },
			permissionProfile: "workspace-write",
		} as never);
		try {
			const header = headerLine(mode);
			expect(header).not.toContain("Mode:");
			expect(header).toContain("Harness: standard@2");
			expect(header).toContain("Permission: workspace-write");
		} finally {
			mode.quit();
		}
	});
});
