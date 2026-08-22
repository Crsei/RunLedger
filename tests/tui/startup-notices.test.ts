import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import type { PresentationBlock } from "../../src/tui/presentation.ts";
import type { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { SettingsResolver } from "../../src/storage/settings-resolver.ts";
import { ContractController, ContractTerminal } from "./fixtures/contract-integration.ts";

function presentationText(block: PresentationBlock): string {
	if (block.kind === "notice") return block.message;
	if ("content" in block) return block.content;
	return "";
}

describe("startup notices", () => {
	it("projects only an unverified workspace capability with project warnings", () => {
		const mode = new InteractiveMode({
			controller: new ContractController({ warnings: ["project warning"] }),
			terminal: new ContractTerminal(),
			workspaceCapability: "ws:macos-unverified",
			syntaxThemeWarnings: ["syntax warning"],
		});
		try {
			const stateNotices = mode.getTuiState().timeline.committedRows
				.filter((row) => row.kind === "notice")
				.map((row) => ({ severity: row.severity, message: row.message.text }));
			expect(stateNotices).toEqual([
				{ severity: "warning", message: "ws:macos-unverified" },
				{ severity: "warning", message: "project warning" },
				{ severity: "warning", message: "syntax warning" },
			]);

			const refs = (mode as unknown as {
				refs: {
					chat: ChatContainer;
					footer: { present(width: number): PresentationBlock[] };
				};
			}).refs;
			const conversation = refs.chat.present(120).map(presentationText).join("\n");
			expect(conversation).toContain("warning: ws:macos-unverified");
			expect(conversation).toContain("warning: project warning");
			expect(conversation).toContain("warning: syntax warning");

			const footer = refs.footer.present(200).map((block) => block.kind === "status-line"
				? block.segments.map((segment) => segment.text).join(" · ")
				: "").join("\n");
			expect(footer).not.toContain("ws:linux-verified");
		} finally {
			mode.quit();
		}
	});

	it("does not project a verified workspace capability into startup notices", () => {
		const mode = new InteractiveMode({
			controller: new ContractController(),
			terminal: new ContractTerminal(),
			workspaceCapability: "ws:linux-verified",
		});
		try {
			const notices = mode.getTuiState().timeline.committedRows.filter((row) => row.kind === "notice");
			expect(notices).toHaveLength(0);

			const refs = (mode as unknown as { refs: { chat: ChatContainer } }).refs;
			const conversation = refs.chat.present(120).map(presentationText).join("\n");
			expect(conversation).not.toContain("ws:linux-verified");
		} finally {
			mode.quit();
		}
	});

	it("suppresses startup notices when the effective startup policy is quiet", () => {
		const runtimeSettings = new SettingsResolver({
			user: { startup: { quiet: true } },
		}).effectiveRuntimeSnapshot();
		const mode = new InteractiveMode({
			controller: new ContractController({ warnings: ["project warning"] }),
			terminal: new ContractTerminal(),
			workspaceCapability: "ws:macos-unverified",
			syntaxThemeWarnings: ["syntax warning"],
			runtimeSettings,
		});
		try {
			expect(mode.getTuiState().timeline.committedRows.filter((row) => row.kind === "notice")).toHaveLength(0);
		} finally {
			mode.quit();
		}
	});

	it("does not mount the Welcome splash when startup.showSplash is disabled", () => {
		const runtimeSettings = new SettingsResolver({
			user: { startup: { showSplash: false } },
		}).effectiveRuntimeSnapshot();
		const mode = new InteractiveMode({
			controller: new ContractController(),
			terminal: new ContractTerminal(),
			runtimeSettings,
			showWelcome: true,
		});
		try {
			const refs = (mode as unknown as { readonly refs: { readonly welcome?: unknown } }).refs;
			expect(refs.welcome).toBeUndefined();
		} finally {
			mode.quit();
		}
	});
});
