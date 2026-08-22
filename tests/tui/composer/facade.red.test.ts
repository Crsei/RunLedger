import { describe, expect, it } from "vitest";
import { projectComposerFrame } from "../../../src/tui/composer/frame.ts";
import { getComposerStyle } from "../../../src/tui/composer/registry.ts";
import { TUI, type Component, type Terminal } from "../../../src/tui/primitives.ts";

class CaptureTerminal implements Terminal {
	columns = 20;
	rows = 10;
	kittyProtocolActive = false;
	output = "";

	start(): void {}
	stop(): void {}
	drainInput(): Promise<void> { return Promise.resolve(); }
	write(data: string): void { this.output += data; }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class DraftComponent implements Component {
	focused = false;
	invalidate(): void {}
	render(): string[] { return ["draft"]; }
	getText(): string { return "draft"; }
	getCursorOffset(): number { return 5; }
}

class StatusFooterComponent implements Component {
	invalidate(): void {}
	render(): string[] { return []; }
	present() {
		return [
			{ kind: "status-line" as const, segments: [{ accent: "state" as const, text: "Working" }, { accent: "model" as const, text: "deepseek" }] },
			{ kind: "status-line" as const, segments: [{ accent: "usage" as const, text: "usage 1k" }] },
		];
	}
}

describe("TUI composer frame facade", () => {
	it("passes the selected pure frame to the non-native rendering path", async () => {
		const terminal = new CaptureTerminal();
		const tui = new TUI(terminal);
		tui.addChild(new DraftComponent());
		tui.setFocus(tui.children[0] ?? null);
		const frame = projectComposerFrame(getComposerStyle("box"), {
			terminalWidth: terminal.columns,
			input: { text: "draft", placeholder: "Message", cursorOffset: 5 },
			status: { identity: "Working", usage: "usage 1k" },
			scrollbar: { visible: false },
		});

		tui.setComposerShape(frame);
		await tui.start();
		try {
			expect(terminal.output).toContain(frame.topRows[0]?.text ?? "");
			expect(terminal.output).toContain(frame.inputRows[0]?.text ?? "");
		} finally {
			tui.stop();
		}
	});

	it("consumes footer status groups that the selected composer attaches", async () => {
		const terminal = new CaptureTerminal();
		terminal.columns = 80;
		const tui = new TUI(terminal);
		const draft = new DraftComponent();
		tui.addChild(draft);
		tui.addChild(new StatusFooterComponent());
		tui.setFocus(draft);
		tui.setComposerShape(getComposerStyle("box"));

		await tui.start();
		try {
			expect(terminal.output.match(/Working · deepseek/gu)).toHaveLength(1);
			expect(terminal.output.match(/usage 1k/gu)).toHaveLength(1);
		} finally {
			tui.stop();
		}
	});
});
