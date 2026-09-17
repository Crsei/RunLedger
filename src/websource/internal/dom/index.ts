/**
 * Vendored HTML DOM 的可用面。
 *
 * 上游对应物是 `packages/utils/src/dom.ts` + `dom/{core,parser,selector}.ts`
 * （linkedom 已用面的行为兼容重写，零外部依赖）。`parseHTML` 返回带 `document`
 * 的 window，供 scraper / credential-free provider 做选择器提取。
 */

import { DOMWindow } from "./core.ts";
import { parseDocument } from "./parser.ts";

export {
	Attr,
	Comment,
	CSSStyleDeclaration,
	CustomEvent,
	DOMTokenList,
	DOMWindow,
	Document,
	DocumentFragment,
	Element,
	Event,
	EventTarget,
	HTMLElement,
	HTMLIFrameElement,
	HTMLMetaElement,
	HTMLTemplateElement,
	NamedNodeMap,
	Node,
	NodeType,
	SVGElement,
	Text,
	serializeNode,
} from "./core.ts";

/** 把 HTML/XML 形状的标记解析为轻量 window 与 document。 */
export function parseHTML(html: string): DOMWindow {
	return new DOMWindow(parseDocument(html));
}
