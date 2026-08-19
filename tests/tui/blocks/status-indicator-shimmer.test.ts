import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";

import { statusIndicatorPlainText } from "../../../src/tui/opentui/component-runtime.ts";
import { shimmerStatusLine } from "../../../src/tui/opentui/shimmer-status-line.ts";
import type { StatusIndicatorView } from "../../../src/tui/presentation.ts";
import { visibleWidth } from "../../../src/tui/primitives.ts";
import { loadTheme } from "../../../src/tui/theme/theme.ts";

const theme = loadTheme("dark");

function working(overrides: Partial<StatusIndicatorView> = {}): StatusIndicatorView {
	return {
		indicator: "⠋",
		header: "Working",
		elapsed: "12s",
		interruptKey: "^C",
		inlineMessage: "Reading workspace",
		...overrides,
	};
}

describe("status indicator shimmer", () => {
	it("colors only the post-truncation working header and inline message", () => {
		const view = working({
			details: [{ text: "detail remains static", truncated: false, byteLength: 21 }],
		});
		const plain = statusIndicatorPlainText(view, 80);
		const rendered = shimmerStatusLine(plain, view, {
			mode: "classic",
			nowMs: 500,
			theme,
			truecolor: true,
		});

		expect(stripAnsi(rendered)).toBe(plain);
		expect(visibleWidth(rendered.split("\n")[0] ?? "")).toBe(visibleWidth(plain.split("\n")[0] ?? ""));
		expect(rendered.split("\n")[0]).toContain("\x1b[38;2;");
		expect(rendered.split("\n")[1]).toBe("  └ detail remains static");
	});

	it("keeps waiting rows on the unchanged static path", () => {
		const view = working({ header: "Waiting", indicator: "⏸", interruptKey: undefined });
		const plain = statusIndicatorPlainText(view, 80);
		expect(shimmerStatusLine(plain, view, {
			mode: "classic",
			nowMs: 500,
			theme,
			truecolor: true,
		})).toBe(plain);
	});

	it("leaves a span unchanged when truncation removes its full header", () => {
		const view = working();
		const plain = statusIndicatorPlainText(view, 8);
		expect(plain).not.toContain(view.header);
		expect(shimmerStatusLine(plain, view, {
			mode: "classic",
			nowMs: 500,
			theme,
			truecolor: true,
		})).toBe(plain);
	});

	it("uses the 256-color fallback without changing visible text", () => {
		const view = working();
		const plain = statusIndicatorPlainText(view, 80);
		const rendered = shimmerStatusLine(plain, view, {
			mode: "kitt",
			nowMs: 100,
			theme,
			truecolor: false,
		});
		expect(rendered).toContain("\x1b[38;5;");
		expect(stripAnsi(rendered)).toBe(plain);
	});

	it("keeps disabled mode static while applying the mid tier", () => {
		const view = working();
		const plain = statusIndicatorPlainText(view, 80);
		const first = shimmerStatusLine(plain, view, {
			mode: "disabled",
			nowMs: 100,
			theme,
			truecolor: true,
		});
		const later = shimmerStatusLine(plain, view, {
			mode: "disabled",
			nowMs: 10_000,
			theme,
			truecolor: true,
		});
		expect(first).toBe(later);
		expect(first).toContain("\x1b[38;2;");
		expect(stripAnsi(first)).toBe(plain);
	});
});
