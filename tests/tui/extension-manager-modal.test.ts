/**
 * TUI extension 管理组件测试 —— ExtensionToggleModal / McpServersModal。
 * 对照 codex skills_toggle_view / mcp server elicitation 的按键与渲染契约。
 */

import { describe, expect, it, vi } from "vitest";
import { ExtensionToggleModal, type ExtensionToggleItem } from "../../src/tui/components/extension-toggle-modal.ts";
import { McpServersModal, type McpServerViewItem } from "../../src/tui/components/mcp-servers-modal.ts";

function renderLines(component: { render(width: number): string[] }, width = 80): string[] {
	return component.render(width);
}

const skills: ExtensionToggleItem[] = [
	{ resourceId: "skill:repo-scout", name: "Repo Scout", description: "Summarize the repo layout", pluginId: "plugin:scout", enabled: true, trusted: true, ready: true, trustLabel: "trusted" },
	{ resourceId: "skill:changelog", name: "Changelog Writer", description: "Draft release notes", pluginId: "plugin:release", enabled: false, trusted: true, ready: false, trustLabel: "trusted" },
];

const plugins: ExtensionToggleItem[] = [
	{ resourceId: "plugin:fixture", name: "fixture", description: "Fixture plugin", pluginId: "plugin:fixture", enabled: true, trusted: false, ready: true, trustLabel: "untrusted" },
];

const servers: McpServerViewItem[] = [
	{
		serverId: "mcp-server:stdio",
		displayName: "stdio-server",
		transport: "stdio",
		required: true,
		state: "ready",
		generation: 2,
		tools: [
			{ rawName: "search", description: "Search issues", isReadOnly: true, isDestructive: false },
			{ rawName: "write", isReadOnly: false, isDestructive: true },
		],
		diagnostics: [],
	},
	{
		serverId: "mcp-server:broken",
		displayName: "broken-server",
		transport: "http",
		required: false,
		state: "failed",
		generation: 1,
		tools: [],
		diagnostics: [{ code: "mcp.startup_failed", message: "connection refused", severity: "error" }],
	},
];

describe("ExtensionToggleModal", () => {
	it("renders codex-style header, search line, toggle markers and footer hint", () => {
		const view = new ExtensionToggleModal({ title: "/skills (2)", subtitle: "Turn skills on or off.", items: skills, onToggle: vi.fn(), onCancel: vi.fn() });
		const lines = renderLines(view);
		expect(lines[0]).toContain("/skills (2)");
		expect(lines[1]).toContain("Turn skills on or off.");
		expect(lines.some((line) => line.includes("[x] Repo Scout"))).toBe(true);
		expect(lines.some((line) => line.includes("[ ] Changelog Writer"))).toBe(true);
		expect(lines.some((line) => line.includes("Press Space or Enter to toggle; Esc to close"))).toBe(true);
	});

	it("filters by search text while preserving selection navigation", () => {
		const view = new ExtensionToggleModal({ title: "/skills", items: skills, onToggle: vi.fn(), onCancel: vi.fn() });
		view.handleInput("changelog");
		const lines = renderLines(view);
		expect(lines.some((line) => line.includes("Changelog Writer"))).toBe(true);
		expect(lines.some((line) => line.includes("Repo Scout"))).toBe(false);
	});

	it("space toggles the selected item through the callback", () => {
		const onToggle = vi.fn();
		const view = new ExtensionToggleModal({ title: "/skills", items: skills, onToggle, onCancel: vi.fn() });
		view.handleInput("space");
		expect(onToggle).toHaveBeenCalledWith(skills[0]);
	});

	it("t toggles trust only when showTrust is set", () => {
		const withTrustSpy = vi.fn();
		const withTrust = new ExtensionToggleModal({ title: "/plugins", items: plugins, showTrust: true, onToggle: vi.fn(), onTrust: withTrustSpy, onCancel: vi.fn() });
		withTrust.handleInput("t");
		expect(withTrustSpy).toHaveBeenCalledWith(plugins[0]);

		const withoutTrustSpy = vi.fn();
		const withoutTrust = new ExtensionToggleModal({ title: "/skills", items: skills, onToggle: vi.fn(), onTrust: withoutTrustSpy, onCancel: vi.fn() });
		withoutTrust.handleInput("t");
		expect(withoutTrustSpy).not.toHaveBeenCalled();
	});

	it("r reloads only when showReload is set", () => {
		const withReloadSpy = vi.fn();
		const withReload = new ExtensionToggleModal({ title: "/plugins", items: plugins, showReload: true, onToggle: vi.fn(), onReload: withReloadSpy, onCancel: vi.fn() });
		withReload.handleInput("r");
		expect(withReloadSpy).toHaveBeenCalledTimes(1);

		const withoutReloadSpy = vi.fn();
		const withoutReload = new ExtensionToggleModal({ title: "/skills", items: skills, onToggle: vi.fn(), onReload: withoutReloadSpy, onCancel: vi.fn() });
		withoutReload.handleInput("r");
		expect(withoutReloadSpy).not.toHaveBeenCalled();
	});

	it("escape cancels and update() refreshes items after mutation", () => {
		const onCancel = vi.fn();
		const view = new ExtensionToggleModal({ title: "/plugins", items: plugins, onToggle: vi.fn(), onCancel });
		view.handleInput("escape");
		expect(onCancel).toHaveBeenCalledTimes(1);

		const toggled = [{ ...plugins[0]!, enabled: false }];
		view.update(toggled);
		expect(renderLines(view).some((line) => line.includes("[ ]"))).toBe(true);
	});
});

describe("McpServersModal", () => {
	it("renders server list with state markers and transport summary", () => {
		const view = new McpServersModal({ servers, onRestart: vi.fn(), onCancel: vi.fn() });
		const lines = renderLines(view);
		expect(lines[0]).toContain("MCP Servers (2)");
		expect(lines.some((line) => line.includes("stdio-server") && line.includes("[ready]"))).toBe(true);
		expect(lines.some((line) => line.includes("broken-server") && line.includes("[failed]"))).toBe(true);
		expect(lines.some((line) => line.includes("2 tools"))).toBe(true);
	});

	it("enter expands tools and diagnostics; r restarts from detail view", () => {
		const onRestart = vi.fn();
		const view = new McpServersModal({ servers, onRestart, onCancel: vi.fn() });
		view.handleInput("down");
		view.handleInput("enter");
		const detail = renderLines(view);
		expect(detail.some((line) => line.includes("Tools:"))).toBe(true);
		expect(detail.some((line) => line.includes("Diagnostics:"))).toBe(true);
		expect(detail.some((line) => line.includes("connection refused"))).toBe(true);

		view.handleInput("r");
		expect(onRestart).toHaveBeenCalledWith(servers[1]);
	});

	it("esc leaves detail back to the list; second esc cancels", () => {
		const onCancel = vi.fn();
		const view = new McpServersModal({ servers, onRestart: vi.fn(), onCancel });
		view.handleInput("enter");
		view.handleInput("escape");
		expect(renderLines(view).some((line) => line.includes("Tools:"))).toBe(false);
		view.handleInput("escape");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("r restarts the selected server from the list", () => {
		const onRestart = vi.fn();
		const view = new McpServersModal({ servers, onRestart, onCancel: vi.fn() });
		view.handleInput("down");
		view.handleInput("r");
		expect(onRestart).toHaveBeenCalledWith(servers[1]);
	});
});
