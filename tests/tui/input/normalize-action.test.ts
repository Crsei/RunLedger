/**
 * B3：normalize-action 验收。
 *
 *   - 归一化 app 输入（已由 OpenTUI boundary 从 raw bytes 转成 callback）→ TuiAction；
 *   - interrupt / request-exit 只产生 intent，不产生 state action（lifecycle 仍在
 *     InteractiveMode/Plan 17）；
 *   - 空 submit 无 action；paste UTF-8 有界。
 */

import { describe, expect, it } from "vitest";
import { normalizeAppInput } from "../../../src/tui/input/normalize-action.ts";

describe("B3 normalize-action", () => {
	it("maps submit to a composer clear only (chat flow owns the rest)", () => {
		expect(normalizeAppInput({ kind: "submit", text: "hello" })).toEqual([
			{ type: "composer.changed", draft: { text: "", truncated: false, byteLength: 0 } },
		]);
		expect(normalizeAppInput({ kind: "submit", text: "   " })).toEqual([]);
	});

	it("bounds composer drafts and paste input", () => {
		const long = "x".repeat(300 * 1024);
		const actions = normalizeAppInput({ kind: "composer-changed", draft: long });
		expect(actions[0]).toMatchObject({ type: "composer.changed" });
		if (actions[0]?.type === "composer.changed") {
			expect(actions[0].draft.truncated).toBe(true);
			expect(actions[0].draft.text.endsWith("…")).toBe(true);
		}
		const paste = normalizeAppInput({ kind: "paste", text: "pasted" });
		expect(paste[0]).toMatchObject({ type: "composer.changed" });
		if (paste[0]?.type === "composer.changed") {
			expect(paste[0].draft.text).toBe("pasted");
		}
	});

	it("maps overlay-close / viewport-clear / select to pure transitions", () => {
		expect(normalizeAppInput({ kind: "overlay-close" })).toEqual([{ type: "overlay.close" }]);
		expect(normalizeAppInput({ kind: "viewport-clear" })).toEqual([{ type: "interaction.viewport-clear" }]);
		expect(normalizeAppInput({ kind: "select", id: "item" })).toEqual([{ type: "interaction.select", id: "item" }]);
		expect(normalizeAppInput({ kind: "select", id: "" })).toEqual([]);
	});

	it("lifecycle intents (interrupt / request-exit) never become state actions", () => {
		expect(normalizeAppInput({ kind: "interrupt" })).toEqual([]);
		expect(normalizeAppInput({ kind: "request-exit" })).toEqual([]);
	});
});
