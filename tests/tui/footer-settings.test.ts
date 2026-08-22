import { describe, expect, it } from "vitest";
import { Footer } from "../../src/tui/components/footer.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";

function provider(settings: unknown) {
	return {
		isStreaming: () => false,
		getStopReason: () => undefined,
		getModelId: () => "model",
		getProviderId: () => "provider",
		getThinkingLevel: () => "high" as const,
		getSessionId: () => "session",
		getWorkspaceDisplayAbsolutePath: () => "/workspace/project",
		getGitBranchLabel: () => "main",
		getPlanProgress: () => ({ completed: 1, total: 2 }),
		getContextUsage: () => ({ totalTokens: 1200, contextWindow: 4000 }),
		getUsageSnapshot: () => undefined,
		getDisplaySettings: () => settings,
	};
}

describe("Footer settings consumer", () => {
	it("uses the configured separator and hides tool/usage presentation without changing identity", () => {
		const footer = new Footer({
			theme: loadTheme("dark"),
			provider: provider({
				statusLine: { separator: " | " },
				display: { hideToolActivity: true, showTokenUsage: false },
			}),
		});

		const blocks = footer.present(200);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ kind: "status-line", separator: " | " });
		const text = (blocks[0] as { readonly segments: readonly { readonly text: string }[] }).segments.map((segment) => segment.text).join(" | ");
		expect(text).toContain("provider/model");
		expect(text).toContain("/workspace/project");
		expect(text).not.toContain("plan (1/2)");
		expect(text).not.toContain("usage ");
		expect(footer.render(200)[0]).toContain(" | ");
	});

	it("keeps only the state and model identity for the minimal preset", () => {
		const footer = new Footer({
			theme: loadTheme("dark"),
			provider: provider({ statusLine: { preset: "minimal" } }),
		});

		const segments = (footer.present(200)[0] as { readonly segments: readonly { readonly accent: string; readonly text: string }[] }).segments;
		expect(segments.map((segment) => segment.accent)).toEqual(["model"]);
		expect(segments[0]?.text).toContain("provider/model");
	});

	it("uses the compact preset to keep model/git/usage while dropping path and plan activity", () => {
		const footer = new Footer({
			theme: loadTheme("dark"),
			provider: provider({ statusLine: { preset: "compact" } }),
		});

		const segments = (footer.present(200)[0] as { readonly segments: readonly { readonly accent: string; readonly text: string }[] }).segments;
		expect(segments.map((segment) => segment.accent)).toEqual(["branch", "model", "usage", "limit"]);
		expect(segments.map((segment) => segment.text).join(" ")).toContain("main");
		expect(segments.map((segment) => segment.text).join(" ")).toContain("provider/model");
		expect(segments.map((segment) => segment.text).join(" ")).toContain("usage 1.2k");
		expect(segments.map((segment) => segment.text).join(" ")).not.toContain("/workspace/project");
		expect(segments.map((segment) => segment.text).join(" ")).not.toContain("plan (1/2)");
	});

	it("keeps rendering a bounded error row when the settings getter throws", () => {
		const throwingProvider = {
			...provider(undefined),
			getDisplaySettings: () => {
				throw new Error("settings failure");
			},
		};
		const footer = new Footer({
			theme: loadTheme("dark"),
			provider: throwingProvider,
		});

		expect(footer.present(200)).toEqual([
			{ kind: "status-line", segments: [{ accent: "state", text: "[footer:err]" }] },
		]);
	});
});
