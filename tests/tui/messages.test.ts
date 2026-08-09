/** canonical Timeline bridge / ChatContainer 单测。 */

import { describe, expect, it } from "vitest";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { visibleWidth } from "../../src/tui/index.ts";

describe("ChatContainer", () => {
	it("空 chat 渲染 0 行", () => {
		const chat = new ChatContainer();
		expect(chat.render(40).length).toBe(0);
	});

	it("按顺序拼接兼容 child 的 render", () => {
		const chat = new ChatContainer();
		chat.push({ render: () => ["a"], invalidate: () => {} });
		chat.push({ render: () => ["b"], invalidate: () => {} });
		expect(chat.render(40)).toEqual(["a", "b"]);
	});

	it("Timeline 投影保留完整助手正文交给 OpenTUI 换行", () => {
		const chat = new ChatContainer();
		const content = "第一段包含超过终端宽度的完整回复内容。\n第二段也必须原样保留，不能变成省略号。";
		chat.setTimelineBlocks([{ id: "timeline-assistant:1/text", kind: "markdown", content, streaming: false }], 1);
		expect(chat.present(20)).toEqual([{ id: "timeline-assistant:1/text", kind: "markdown", content, streaming: false }]);
	});

	it.each([60, 80, 143])("按真实宽度生成 run separator（%i 列）", (width) => {
		const chat = new ChatContainer();
		chat.setTimelineBlocks([{ id: "timeline-run:run-1", kind: "separator", label: "stop · Worked for 1m 00s" }], 1);
		const block = chat.present(width)[0];
		expect(block).toMatchObject({ id: "timeline-run:run-1", kind: "separator" });
		expect(block && "content" in block ? visibleWidth(block.content) : -1).toBe(width);
		expect(block && "content" in block ? block.content : "").toContain("stop · Worked for 1m 00s");
	});

	it("child 抛错时不外抛并显示有界占位", () => {
		const chat = new ChatContainer();
		chat.push({ invalidate: () => {}, render: () => { throw new Error("simulated"); } });
		const lines = chat.render(20);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[chat:child-render-");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(20);
	});
});
