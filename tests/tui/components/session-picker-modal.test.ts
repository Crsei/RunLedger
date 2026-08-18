import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogItem } from "../../../src/tui/sessions/types.ts";
import {
	SessionPickerModal,
	buildSessionPickerItems,
	formatRelativeTime,
	type SessionPickerItem,
} from "../../../src/tui/components/session-picker-modal.ts";

const NOW_MS = 1_000_000_000_000;

// updated desc 顺序:11111111(1m 前更新)> 22222222(1h 前更新)> 33333333(2d 前);
// created desc 顺序:22222222(1h 前创建)> 11111111(1d 前创建)> 33333333(2d 前创建)。
const catalogItems: SessionCatalogItem[] = [
	{ sessionId: "session_11111111aaaaaaaa", workspaceId: "workspace-1", repositoryId: "repository-1", status: "active", createdAtMs: NOW_MS - 86_400_000, updatedAtMs: NOW_MS - 60_000, headSequence: 7, driverRevision: 1, title: "Fix login button", titleSource: "user", titleUpdatedAtMs: NOW_MS - 50_000, current: true },
	{ sessionId: "session_22222222bbbbbbbb", workspaceId: "workspace-1", repositoryId: "repository-1", status: "paused", createdAtMs: NOW_MS - 3_600_000, updatedAtMs: NOW_MS - 3_600_000, headSequence: 5, driverRevision: 0, firstUserMessagePreview: "Resume paused session", current: false },
	{ sessionId: "session_33333333cccccccc", workspaceId: "workspace-2", repositoryId: "repository-2", status: "completed", createdAtMs: NOW_MS - 2 * 86_400_000, updatedAtMs: NOW_MS - 2 * 86_400_000, headSequence: 12, driverRevision: 2, current: false },
];

function items(): SessionPickerItem[] {
	return buildSessionPickerItems(catalogItems, NOW_MS);
}

function presentSelect(modal: SessionPickerModal): { title: string; options: readonly { value: string; label: string; description?: string }[]; selectedIndex: number } {
	const select = modal.present().find((block) => block.kind === "select") as { title: string; options: readonly { value: string; label: string; description?: string }[]; selectedIndex: number };
	return select;
}

function selectedValue(modal: SessionPickerModal): string | undefined {
	const select = presentSelect(modal);
	return select.options[select.selectedIndex]?.value;
}

describe("formatRelativeTime", () => {
	it("renders just now within a minute", () => {
		expect(formatRelativeTime(NOW_MS - 5_000, NOW_MS)).toBe("just now");
	});

	it("renders Nm/Nh/Nd ago within a week", () => {
		expect(formatRelativeTime(NOW_MS - 5 * 60_000, NOW_MS)).toBe("5m ago");
		expect(formatRelativeTime(NOW_MS - 3 * 3_600_000, NOW_MS)).toBe("3h ago");
		expect(formatRelativeTime(NOW_MS - 4 * 86_400_000, NOW_MS)).toBe("4d ago");
	});

	it("falls back to a date beyond a week", () => {
		const date = new Date(2026, 0, 5).getTime();
		expect(formatRelativeTime(date, date + 8 * 86_400_000)).toBe("2026-01-05");
	});
});

describe("buildSessionPickerItems", () => {
	it("prioritizes title, then first-message preview, then the time fallback", () => {
		const rows = items();
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			value: "session_11111111aaaaaaaa",
			label: "Fix login button · active · current",
			description: "workspace-1 · head 7 · 1m ago",
			denseLabel: "1m ago    Fix login button · active",
			denseDescription: "head 7 · workspace-1",
			current: true,
		});
		expect(rows[1]!.label).toBe("Resume paused session · paused");
		expect(rows[2]!.label).toBe("Untitled · 2d ago · completed");
		expect(rows[0]!.expandedDescription).toContain("session_11111111aaaaaaaa");
		expect(rows[0]!.expandedDescription).toContain("created 1d ago");
		expect(rows[0]!.searchText).toContain("workspace-1");
	});

	it("marks non-current rows without the current suffix", () => {
		expect(items()[1]!.label).toBe("Resume paused session · paused");
	});
});

describe("SessionPickerModal", () => {
	function makeModal(onSelect?: (item: SessionPickerItem) => void, onCancel?: () => void, currentWorkspaceId?: string): SessionPickerModal {
		return new SessionPickerModal({
			title: "/resume",
			items: items(),
			currentWorkspaceId,
			onSelect: onSelect ?? vi.fn(),
			onCancel: onCancel ?? vi.fn(),
		});
	}

	it("defaults to updated-desc sort and cwd filter", () => {
		const modal = makeModal(undefined, undefined, "workspace-1");
		const select = presentSelect(modal);
		expect(select.title).toBe("/resume (2)");
		expect(select.options.map((option) => option.value)).toEqual([
			"session_11111111aaaaaaaa",
			"session_22222222bbbbbbbb",
		]);
		expect(selectedValue(modal)).toBe("session_11111111aaaaaaaa");
	});

	it("locks to all when no current workspace is known", () => {
		const modal = makeModal();
		expect(presentSelect(modal).title).toBe("/resume (3)");
	});

	it("ctrl+s toggles to created-desc sort", () => {
		const modal = makeModal(undefined, undefined, "workspace-1");
		modal.handleInput("ctrl+s");
		expect(presentSelect(modal).options.map((option) => option.value)).toEqual([
			"session_22222222bbbbbbbb",
			"session_11111111aaaaaaaa",
		]);
		modal.handleInput("ctrl+s");
		expect(presentSelect(modal).options.map((option) => option.value)).toEqual([
			"session_11111111aaaaaaaa",
			"session_22222222bbbbbbbb",
		]);
	});

	it("ctrl+f toggles the workspace filter", () => {
		const modal = makeModal(undefined, undefined, "workspace-1");
		modal.handleInput("ctrl+f");
		expect(presentSelect(modal).title).toBe("/resume (3)");
		modal.handleInput("ctrl+f");
		expect(presentSelect(modal).title).toBe("/resume (2)");
	});

	it("typing filters by session id, workspace, repository and status", () => {
		const modal = makeModal(undefined, undefined, "workspace-1");
		modal.handleInput("2");
		expect(presentSelect(modal).title).toBe("/resume (1)");
		expect(selectedValue(modal)).toBe("session_22222222bbbbbbbb");
		modal.handleInput("z");
		expect(presentSelect(modal).title).toBe("/resume (0)");
		modal.handleInput("backspace");
		expect(presentSelect(modal).title).toBe("/resume (1)");
		modal.handleInput("backspace");
		modal.handleInput("paused");
		expect(presentSelect(modal).title).toBe("/resume (1)");
		for (let index = 0; index < 6; index++) modal.handleInput("backspace");
		modal.handleInput("ctrl+f");
		modal.handleInput("workspace-2");
		expect(presentSelect(modal).title).toBe("/resume (1)");
		expect(selectedValue(modal)).toBe("session_33333333cccccccc");
	});

	it("ctrl+e expands the selected row description", () => {
		const modal = makeModal(undefined, undefined, "workspace-1");
		const select = presentSelect(modal);
		expect(select.options[0]!.description).toBe("workspace-1 · head 7 · 1m ago");
		modal.handleInput("ctrl+e");
		const expanded = presentSelect(modal);
		expect(expanded.options[0]!.description).toContain("session_11111111aaaaaaaa");
		expect(expanded.options[0]!.description).toContain("driver 1");
		modal.handleInput("ctrl+e");
		expect(presentSelect(modal).options[0]!.description).toBe("workspace-1 · head 7 · 1m ago");
	});

	it("ctrl+o toggles between comfortable and dense rows", () => {
		const modal = makeModal(undefined, undefined, "workspace-1");
		expect(presentSelect(modal).options[0]!.label).toContain("· active");
		modal.handleInput("ctrl+o");
		const dense = presentSelect(modal);
		expect(dense.options[0]!.label).toBe("1m ago    Fix login button · active");
		expect(dense.options[0]!.description).toBe("head 7 · workspace-1");
		modal.handleInput("ctrl+o");
		expect(presentSelect(modal).options[0]!.label).toContain("· active");
	});

	it("enter selects the visible row and cancels on ctrl+c", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const modal = makeModal(onSelect, onCancel, "workspace-1");
		modal.handleInput("enter");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: "session_11111111aaaaaaaa" }));
		modal.handleInput("ctrl+c");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("escape clears a non-empty query before cancelling", () => {
		const onCancel = vi.fn();
		const modal = makeModal(undefined, onCancel, "workspace-1");
		modal.handleInput("paused");
		modal.handleInput("escape");
		expect(onCancel).not.toHaveBeenCalled();
		expect(presentSelect(modal).title).toBe("/resume (2)");
		modal.handleInput("escape");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("arrow keys clamp at the boundaries and page/home/end jump", () => {
		const modal = makeModal(undefined, undefined, "workspace-1");
		modal.handleInput("up");
		expect(selectedValue(modal)).toBe("session_11111111aaaaaaaa");
		modal.handleInput("down");
		expect(selectedValue(modal)).toBe("session_22222222bbbbbbbb");
		modal.handleInput("down");
		expect(selectedValue(modal)).toBe("session_22222222bbbbbbbb");
		modal.handleInput("home");
		expect(selectedValue(modal)).toBe("session_11111111aaaaaaaa");
		modal.handleInput("end");
		expect(selectedValue(modal)).toBe("session_22222222bbbbbbbb");
		modal.handleInput("pageUp");
		expect(selectedValue(modal)).toBe("session_11111111aaaaaaaa");
		modal.handleInput("pageDown");
		expect(selectedValue(modal)).toBe("session_22222222bbbbbbbb");
	});

	it("renders a toolbar line and a hints line alongside the select block", () => {
		const modal = makeModal(undefined, undefined, "workspace-1");
		const blocks = modal.present();
		const toolbar = blocks[0] as { kind: "text"; content: string };
		const hints = blocks[2] as { kind: "text"; content: string };
		expect(toolbar).toMatchObject({ kind: "text", content: expect.stringContaining("Filter: [Cwd]") });
		expect(hints).toMatchObject({ kind: "text", content: expect.stringContaining("enter resume") });
		expect(hints.content).toContain("1/2");
	});

	it("shows an empty placeholder when nothing matches", () => {
		const onSelect = vi.fn();
		const modal = makeModal(onSelect, undefined, "workspace-1");
		modal.handleInput("zzz");
		const select = presentSelect(modal);
		expect(select.title).toBe("/resume (0)");
		expect(select.options[0]!.label).toBe("No matching sessions");
		modal.handleInput("enter");
		// 占位行不可被选中提交
		expect(onSelect).not.toHaveBeenCalled();
	});
});
