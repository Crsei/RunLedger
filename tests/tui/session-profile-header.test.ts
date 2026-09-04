import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { ContractController, ContractTerminal } from "./fixtures/contract-integration.ts";

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
			const header = (mode as unknown as {
				refs: { readonly header: { render(width: number): readonly string[] } };
			}).refs.header.render(120).join("\n");
			expect(header).toContain("Harness: minimal@1");
			expect(header).toContain("Permission: workspace-write");
			expect(header).toContain("Thinking: high");
			expect(header).not.toContain("thinking=minimal");
		} finally {
			mode.quit();
		}
	});
});
