/**
 * 受限 XML 解析器。
 *
 * 文档转换只需要命名空间保留、属性与文本节点；引入一个完整 XML 依赖会扩大
 * 运行时面，因此这里明确拒绝 DTD/自定义 entity，并在进入树构建前施加资源上限。
 * OOXML/EPUB 的标准预定义 entity 和数值 entity 仍可使用。
 */

export interface XmlTextNode {
	readonly kind: "text";
	readonly text: string;
}

export interface XmlElement {
	readonly kind: "element";
	readonly name: string;
	readonly attributes: ReadonlyMap<string, string>;
	readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | XmlTextNode;

export interface XmlParseLimits {
	readonly maxBytes?: number;
	readonly maxDepth?: number;
	readonly maxElements?: number;
	readonly maxEntityReferences?: number;
}

const DEFAULT_LIMITS: Required<XmlParseLimits> = {
	maxBytes: 1_000_000,
	maxDepth: 64,
	maxElements: 50_000,
	maxEntityReferences: 100_000,
};

interface MutableElement {
	readonly name: string;
	readonly attributes: Map<string, string>;
	readonly children: XmlNode[];
}

const ENTITY_VALUES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	quot: '"',
};

/** 解析单个 XML document，根元素外的非空文本和不配对标签一律拒绝。 */
export function parseXml(source: string, options: XmlParseLimits = {}): XmlElement {
	const limits = { ...DEFAULT_LIMITS, ...options };
	if (Buffer.byteLength(source, "utf8") > limits.maxBytes) {
		throw new Error(`XML exceeds ${limits.maxBytes} byte limit`);
	}
	if (/<!DOCTYPE\b|<!ENTITY\b/iu.test(source)) {
		throw new Error("XML DTD and custom entities are not supported");
	}

	const stack: MutableElement[] = [];
	let root: XmlElement | undefined;
	let index = 0;
	let elementCount = 0;
	let entityReferences = 0;

	function decode(value: string): string {
		const decoded = value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]*);/giu, (whole, entity: string) => {
			entityReferences += 1;
			if (entityReferences > limits.maxEntityReferences) {
				throw new Error(`XML exceeds ${limits.maxEntityReferences} entity reference limit`);
			}
			if (entity[0] !== "#") {
				const named = ENTITY_VALUES[entity];
				if (named === undefined) throw new Error(`Unsupported XML entity '&${entity};'`);
				return named;
			}
			const hexadecimal = entity[1]?.toLowerCase() === "x";
			const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
			if (
				!Number.isFinite(codePoint) ||
				codePoint <= 0 ||
				codePoint > 0x10ffff ||
				(codePoint >= 0xd800 && codePoint <= 0xdfff)
			) {
				throw new Error(`Invalid XML character reference '&${entity};'`);
			}
			return String.fromCodePoint(codePoint);
		});
		if (decoded.includes("&")) throw new Error("Malformed XML entity reference");
		return decoded;
	}

	function append(node: XmlNode): void {
		const parent = stack[stack.length - 1];
		if (parent === undefined) {
			if (node.kind === "text" && node.text.trim().length === 0) return;
			throw new Error("XML has content outside its root element");
		}
		parent.children.push(node);
	}

	while (index < source.length) {
		if (source[index] !== "<") {
			const end = source.indexOf("<", index);
			const text = decode(source.slice(index, end === -1 ? source.length : end));
			if (text.length > 0) append({ kind: "text", text });
			index = end === -1 ? source.length : end;
			continue;
		}
		if (source.startsWith("<?", index)) {
			const end = source.indexOf("?>", index + 2);
			if (end === -1) throw new Error("Unterminated XML processing instruction");
			index = end + 2;
			continue;
		}
		if (source.startsWith("<!--", index)) {
			const end = source.indexOf("-->", index + 4);
			if (end === -1) throw new Error("Unterminated XML comment");
			index = end + 3;
			continue;
		}
		if (source.startsWith("<![CDATA[", index)) {
			const end = source.indexOf("]]>", index + 9);
			if (end === -1) throw new Error("Unterminated XML CDATA section");
			append({ kind: "text", text: source.slice(index + 9, end) });
			index = end + 3;
			continue;
		}
		if (source.startsWith("</", index)) {
			const end = source.indexOf(">", index + 2);
			if (end === -1) throw new Error("Unterminated XML closing tag");
			const name = source.slice(index + 2, end).trim();
			if (!isXmlName(name)) throw new Error(`Invalid XML closing tag '${name}'`);
			const current = stack.pop();
			if (current === undefined || current.name !== name) {
				throw new Error(`Mismatched XML closing tag '${name}'`);
			}
			const finished: XmlElement = {
				kind: "element",
				name: current.name,
				attributes: current.attributes,
				children: current.children,
			};
			if (stack.length === 0) {
				if (root !== undefined) throw new Error("XML has multiple root elements");
				root = finished;
			} else {
				append(finished);
			}
			index = end + 1;
			continue;
		}

		const end = findTagEnd(source, index + 1);
		if (end === -1) throw new Error("Unterminated XML start tag");
		const rawTag = source.slice(index + 1, end);
		const selfClosing = /\/\s*$/u.test(rawTag);
		const parsed = parseStartTag(selfClosing ? rawTag.replace(/\/\s*$/u, "") : rawTag, decode);
		elementCount += 1;
		if (elementCount > limits.maxElements) throw new Error(`XML exceeds ${limits.maxElements} element limit`);
		if (stack.length + 1 > limits.maxDepth) throw new Error(`XML exceeds ${limits.maxDepth} nesting limit`);
		const element: MutableElement = { name: parsed.name, attributes: parsed.attributes, children: [] };
		if (selfClosing) {
			const finished: XmlElement = {
				kind: "element",
				name: element.name,
				attributes: element.attributes,
				children: element.children,
			};
			if (stack.length === 0) {
				if (root !== undefined) throw new Error("XML has multiple root elements");
				root = finished;
			} else {
				append(finished);
			}
		} else {
			stack.push(element);
		}
		index = end + 1;
	}
	if (stack.length > 0) throw new Error(`Unclosed XML element '${stack[stack.length - 1]!.name}'`);
	if (root === undefined) throw new Error("XML document has no root element");
	return root;
}

export function childElements(element: XmlElement, name?: string): XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === "element" && (name === undefined || child.name === name));
}

export function firstChildElement(element: XmlElement, name: string): XmlElement | undefined {
	return childElements(element, name)[0];
}

export function descendantElements(element: XmlElement, name: string): XmlElement[] {
	const matches: XmlElement[] = [];
	for (const child of childElements(element)) {
		if (child.name === name) matches.push(child);
		matches.push(...descendantElements(child, name));
	}
	return matches;
}

export function xmlText(element: XmlElement): string {
	return element.children.map(child => (child.kind === "text" ? child.text : xmlText(child))).join("");
}

function isXmlName(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(value);
}

function findTagEnd(source: string, start: number): number {
	let quote: "'" | '"' | undefined;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
		} else if (character === "'" || character === '"') {
			quote = character;
		} else if (character === ">") {
			return index;
		}
	}
	return -1;
}

function parseStartTag(source: string, decode: (value: string) => string): { name: string; attributes: Map<string, string> } {
	const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_.:-]*)/u.exec(source);
	if (nameMatch?.[1] === undefined) throw new Error("Invalid XML start tag");
	const name = nameMatch[1];
	const attributes = new Map<string, string>();
	let index = nameMatch[0].length;
	while (index < source.length) {
		while (/\s/u.test(source[index] ?? "")) index += 1;
		if (index === source.length) break;
		const attributeMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(source.slice(index));
		if (attributeMatch?.[0] === undefined) throw new Error("Invalid XML attribute name");
		const attributeName = attributeMatch[0];
		if (attributes.has(attributeName)) throw new Error(`Duplicate XML attribute '${attributeName}'`);
		index += attributeName.length;
		while (/\s/u.test(source[index] ?? "")) index += 1;
		if (source[index] !== "=") throw new Error(`XML attribute '${attributeName}' has no value`);
		index += 1;
		while (/\s/u.test(source[index] ?? "")) index += 1;
		const quote = source[index];
		if (quote !== "'" && quote !== '"') throw new Error(`XML attribute '${attributeName}' must be quoted`);
		const valueEnd = source.indexOf(quote, index + 1);
		if (valueEnd === -1) throw new Error(`Unterminated XML attribute '${attributeName}'`);
		attributes.set(attributeName, decode(source.slice(index + 1, valueEnd)));
		index = valueEnd + 1;
	}
	return { name, attributes };
}
