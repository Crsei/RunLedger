import { describe, expect, it } from "vitest";
import { statusLineToStyledText, softenStatusColor, type StatusLineSegment } from "../../src/tui/highlight/status-style.ts";

describe("Codex status line style", () => {
	it("maps path/model/branch to exact ordered scopes and semantic fallbacks", () => {
		const calls: string[][] = [];
		const segments: StatusLineSegment[] = [
			{ accent: "model", text: "deepseek" },
			{ accent: "path", text: "~/RunLedger" },
			{ accent: "branch", text: "main" },
		];
		const styled = statusLineToStyledText(segments, (scopes) => {
			calls.push([...scopes]);
			return undefined;
		});
		expect(calls).toEqual([
			["entity.name.type", "support.type", "variable"],
			["string", "markup.underline.link"],
			["entity.name.function", "entity.name.tag"],
		]);
		expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe("deepseek · ~/RunLedger · main");
		expect(styled.chunks[0]?.fg?.slot).toBe(6);
		expect(styled.chunks[2]?.fg?.slot).toBe(2);
		expect(styled.chunks[4]?.fg?.slot).toBe(5);
		expect(styled.chunks[1]?.attributes).not.toBe(0);
	});

	it("softens RGB with the Codex 85 percent saturation formula and keeps indexed intent", () => {
		expect(softenStatusColor({ kind: "rgb", r: 255, g: 0, b: 0 })).toEqual({ kind: "rgb", r: 228, g: 11, b: 11 });
		expect(softenStatusColor({ kind: "indexed", index: 12 })).toEqual({ kind: "indexed", index: 12 });
		expect(softenStatusColor({ kind: "default" })).toEqual({ kind: "default" });
	});

	it("uses the first theme foreground and does not dim ordinary segments", () => {
		const styled = statusLineToStyledText([{ accent: "path", text: "project" }], () => ({ kind: "rgb", r: 255, g: 0, b: 0 }));
		expect(styled.chunks[0]?.fg?.toInts().slice(0, 3)).toEqual([228, 11, 11]);
		expect(styled.chunks[0]?.attributes).toBeUndefined();
	});
});
