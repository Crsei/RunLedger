/** DOCX 的最小 OOXML 投影：只读取正文段落、表格和图片占位，不处理样式写回。 */

import {
	childElements,
	descendantElements,
	firstChildElement,
	parseXml,
	xmlText,
	type XmlElement,
} from "../xml.ts";

function escapeTableCell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
}

function paragraphText(paragraph: XmlElement): string {
	const pieces: string[] = [];
	for (const child of descendantElements(paragraph, "w:t")) pieces.push(xmlText(child));
	for (const _break of descendantElements(paragraph, "w:br")) pieces.push("\n");
	return pieces.join("").replace(/[ \t]+\n/gu, "\n").trim();
}

function headingPrefix(paragraph: XmlElement): string {
	const properties = firstChildElement(paragraph, "w:pPr");
	const style = properties === undefined ? undefined : firstChildElement(properties, "w:pStyle")?.attributes.get("w:val");
	if (style === "Title") return "#";
	const match = /^Heading([1-6])$/u.exec(style ?? "");
	return match === null ? "" : "#".repeat(Number(match[1]));
}

function renderTable(table: XmlElement): string | undefined {
	const rows = childElements(table, "w:tr").map(row =>
		childElements(row, "w:tc").map(cell => escapeTableCell(descendantElements(cell, "w:p").map(paragraphText).join(" "))),
	);
	if (rows.length === 0) return undefined;
	const columnCount = Math.max(...rows.map(row => row.length));
	for (const row of rows) while (row.length < columnCount) row.push("");
	const [header, ...body] = rows;
	if (header === undefined) return undefined;
	return [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map(row => `| ${row.join(" | ")} |`),
	].join("\n");
}

/** 将 `word/document.xml` 的主正文转成有界 Markdown 构件。 */
export function documentXmlToMarkdown(xml: string): string {
	const root = parseXml(xml);
	if (root.name !== "w:document") throw new Error("Invalid DOCX: word/document.xml root is not w:document");
	const body = firstChildElement(root, "w:body");
	if (body === undefined) throw new Error("Invalid DOCX: missing w:body");
	const sections: string[] = [];
	let imageCount = 0;
	for (const child of childElements(body)) {
		if (child.name === "w:p") {
			const text = paragraphText(child);
			if (text) {
				const prefix = headingPrefix(child);
				sections.push(prefix ? `${prefix} ${text}` : text);
			}
			const images = descendantElements(child, "w:drawing").length;
			for (let index = 0; index < images; index += 1) {
				imageCount += 1;
				sections.push(`<!-- image omitted: ${imageCount} -->`);
			}
		} else if (child.name === "w:tbl") {
			const table = renderTable(child);
			if (table) sections.push(table);
		}
	}
	return sections.join("\n\n").trim();
}
