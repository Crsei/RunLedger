/**
 * Turndown 实例构造。
 *
 * 来源：oh-my-pi `packages/coding-agent/src/utils/turndown.ts`（快照
 * `1c0303b1`）。`./turndown/**` 是该仓库自带的 turndown 兼容实现
 * （`packages/utils/src/turndown/**`）。此处只保留 web scraper 需要的构造与 GFM
 * 装配；`normalizeTablesHtml` 属于 markit 文档转换路径，未移植。
 */

import { gfm } from "./gfm.ts";
import TurndownService from "./service.ts";

type TurndownListParent = {
	readonly nodeName: string;
	getAttribute(name: string): string | null;
	readonly children: ArrayLike<unknown>;
};

/**
 * 与上游规则集保持一致：GFM 插件 + `~~` 删除线 + 标题不转义句点 +
 * 列表标记后单空格。scraper 的输出稳定性依赖这套规则。
 */
export function createTurndown(): TurndownService {
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	turndown.use(gfm);
	turndown.addRule("strikethrough", {
		filter: ["del", "s", "strike"],
		replacement(content) {
			return `~~${content}~~`;
		},
	});
	turndown.addRule("heading", {
		filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
		replacement(content, node) {
			const level = Number(node.nodeName.charAt(1));
			const prefix = "#".repeat(level);
			const cleaned = content.replace(/\\([.])/g, "$1").trim();
			return `\n\n${prefix} ${cleaned}\n\n`;
		},
	});
	turndown.addRule("listItem", {
		filter: "li",
		replacement(content, node, options) {
			const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
			const parent = node.parentNode as unknown as TurndownListParent | null;
			let prefix = `${options.bulletListMarker} `;
			if (parent?.nodeName === "OL") {
				const start = parent.getAttribute("start");
				const index = Array.prototype.indexOf.call(parent.children, node);
				prefix = `${(start ? Number(start) : 1) + index}. `;
			}
			return prefix + body + (node.nextSibling ? "\n" : "");
		},
	});
	return turndown;
}
