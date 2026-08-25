import { describe, expect, test } from "bun:test";
import {
	WelcomeComponent,
	WELCOME_SESSION_SLOTS,
	type WelcomeComponentProps,
} from "../../src/tui/components/welcome.ts";
import { renderLogo } from "../../src/tui/components/logo.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

const theme = loadTheme("dark");

function makeWelcome(overrides: Partial<WelcomeComponentProps> = {}): WelcomeComponent {
	return new WelcomeComponent({
		version: "0.0.1-test",
		theme,
		modelLabel: "claude-3.7",
		providerLabel: "anthropic",
		directoryLabel: "/repo",
		branchLabel: "main",
		recentSessions: [
			{ name: "fix auth", timeAgo: "2m ago" },
			{ name: "port lsp", timeAgo: "1h ago" },
		],
		...overrides,
	});
}

describe("WelcomeComponent", () => {
	test("renders box title with version and left-column content", () => {
		const joined = makeWelcome().render(100).join("\n");
		expect(joined).toContain("RunLedger v0.0.1-test");
		expect(joined).toContain("Welcome back!");
		expect(joined).toContain("claude-3.7");
		expect(joined).toContain("anthropic");
	});

	test("no line exceeds the requested width at any common width", () => {
		for (const width of [100, 80, 60, 40, 24]) {
			for (const line of makeWelcome().render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("right column renders when wide and collapses when narrow", () => {
		expect(makeWelcome().render(100).join("\n")).toContain("Quick keys");
		expect(makeWelcome().render(40).join("\n")).not.toContain("Quick keys");
	});

	test("shows 'No recent sessions' placeholder when empty", () => {
		expect(makeWelcome({ recentSessions: [] }).render(100).join("\n")).toContain("No recent sessions");
	});

	test("lists at most WELCOME_SESSION_SLOTS recent sessions", () => {
		const welcome = makeWelcome({
			recentSessions: Array.from({ length: 8 }, (_, i) => ({ name: `session-${i}`, timeAgo: "1m ago" })),
		});
		const joined = welcome.render(100).join("\n");
		for (let i = 0; i < 8; i++) expect(joined.includes(`session-${i}`)).toBe(i < WELCOME_SESSION_SLOTS);
	});

	test("render returns the cached array for repeated same-width calls", () => {
		const welcome = makeWelcome();
		const first = welcome.render(80);
		expect(welcome.render(80)).toBe(first);
	});

	test("setRecentSessions and setModel invalidate the cache", () => {
		const welcome = makeWelcome();
		const first = welcome.render(80);
		welcome.setRecentSessions([{ name: "new session", timeAgo: "just now" }]);
		welcome.setModel("new-model", "new-provider");
		const second = welcome.render(80);
		expect(second).not.toBe(first);
		expect(second.join("\n")).toContain("new session");
		expect(second.join("\n")).toContain("new-model");
	});

	test("renders a Tip row beneath the box", () => {
		expect(makeWelcome().render(100).join("\n")).toContain("Tip:");
	});

	test("uses the configured logo letters when calculating and rendering the left column", () => {
		const welcome = makeWelcome({ logoLetters: "rue" });
		const joined = welcome.render(100).join("\n");
		expect(joined).toContain(renderLogo(theme, "rue")[0] ?? "");
		expect(joined).not.toContain(renderLogo(theme)[0] ?? "");
		expect(visibleWidth(welcome.render(100)[0] ?? "")).toBeLessThanOrEqual(100);
	});

	test("returns [] below the minimum box width", () => {
		expect(makeWelcome().render(3)).toEqual([]);
	});
});
