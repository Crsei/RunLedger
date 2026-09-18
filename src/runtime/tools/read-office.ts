/**
 * `read` 的 DOCX/PPTX/XLSX/EPUB 分支。
 *
 * 输入只能是调用方经 governed fs 取得的字节；这里不接收路径、不解出附件、更不写
 * 图片。ZIP 解析复用仓内受限 ArchiveReader，XML 解析拒绝 DTD 与自定义 entity。
 */

import { openArchive, type ArchiveReader } from "../../websource/internal/ar/index.ts";
import { convertDocxArchive } from "../../websource/internal/docx/index.ts";
import {
	childElements,
	descendantElements,
	firstChildElement,
	parseXml,
	xmlText,
	type XmlElement,
} from "../../websource/internal/xml.ts";
import { createTurndown } from "../../websource/internal/turndown/create.ts";

export type OfficeFormat = "docx" | "pptx" | "xlsx" | "epub";

export interface OfficeReadTarget {
	readonly path: string;
	readonly format: OfficeFormat;
}

export interface OfficeReadResult {
	readonly text: string;
	readonly format: OfficeFormat;
}

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_ENTRIES = 10_000;
const MAX_DOCUMENT_MEMBER_BYTES = 1_000_000;
const MAX_DOCUMENT_OUTPUT_CHARS = 2_000_000;
const XML_DECODER = new TextDecoder("utf-8", { fatal: true });

const EXTENSION_FORMATS: Readonly<Record<string, OfficeFormat>> = {
	".docx": "docx",
	".epub": "epub",
	".pptx": "pptx",
	".xlsx": "xlsx",
};

/** 按扩展名判定；magic/container 校验由 `readOfficeBytes` 完成。 */
export function parseOfficeReadTarget(path: string): OfficeReadTarget | null {
	const lower = path.toLowerCase();
	for (const [extension, format] of Object.entries(EXTENSION_FORMATS)) {
		if (lower.endsWith(extension)) return { path, format };
	}
	return null;
}

export function isOfficeDocumentSizeAllowed(size: number): boolean {
	return Number.isSafeInteger(size) && size >= 0 && size <= MAX_DOCUMENT_BYTES;
}

export async function readOfficeBytes(bytes: Uint8Array, format: OfficeFormat): Promise<OfficeReadResult> {
	if (!isOfficeDocumentSizeAllowed(bytes.byteLength)) {
		throw new Error(`${format.toUpperCase()} exceeds ${MAX_DOCUMENT_BYTES} byte input limit`);
	}
	const archive = await openArchive(
		{ bytes, format: "zip" },
		{
			limits: {
				maxEntries: MAX_DOCUMENT_ENTRIES,
				maxInMemorySize: MAX_DOCUMENT_BYTES,
				maxIndexSize: MAX_DOCUMENT_BYTES,
				maxMemberSize: MAX_DOCUMENT_MEMBER_BYTES,
			},
		},
	);
	let text: string;
	switch (format) {
		case "docx":
			text = await convertDocxArchive(archive);
			break;
		case "pptx":
			text = await convertPptx(archive);
			break;
		case "xlsx":
			text = await convertXlsx(archive);
			break;
		case "epub":
			text = await convertEpub(archive);
			break;
	}
	if (text.length > MAX_DOCUMENT_OUTPUT_CHARS) {
		throw new Error(`${format.toUpperCase()} conversion exceeds ${MAX_DOCUMENT_OUTPUT_CHARS} character output limit`);
	}
	return { text, format };
}

async function readXml(archive: ArchiveReader, path: string, label: string): Promise<XmlElement> {
	const node = archive.getNode(path);
	if (node === undefined || node.isDirectory) throw new Error(`Invalid ${label}: missing ${path}`);
	try {
		return parseXml(XML_DECODER.decode((await archive.readFile(path)).bytes));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${label}: ${message}`);
	}
}

function readText(element: XmlElement): string {
	return xmlText(element).replace(/\s+/gu, " ").trim();
}

function valuesFromRuns(element: XmlElement, textElementName: string): string {
	return descendantElements(element, textElementName).map(xmlText).join("").trim();
}

function markdownTable(rows: readonly string[][]): string | undefined {
	if (rows.length === 0) return undefined;
	const width = Math.max(...rows.map(row => row.length));
	if (width === 0) return undefined;
	const normalized = rows.map(row => {
		const copy = row.map(value => value.replaceAll("|", "\\|").replace(/\s+/gu, " ").trim());
		while (copy.length < width) copy.push("");
		return copy;
	});
	const [header, ...body] = normalized;
	if (header === undefined) return undefined;
	return [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map(row => `| ${row.join(" | ")} |`),
	].join("\n");
}

function archivePath(basePath: string, target: string): string | undefined {
	if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("/")) return undefined;
	const parts = basePath.split("/").filter(Boolean);
	for (const part of target.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return undefined;
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return parts.join("/");
}

function relationships(document: XmlElement): ReadonlyMap<string, string> {
	const map = new Map<string, string>();
	for (const relation of childElements(document, "Relationship")) {
		const id = relation.attributes.get("Id");
		const target = relation.attributes.get("Target");
		if (id && target) map.set(id, target);
	}
	return map;
}

async function convertPptx(archive: ArchiveReader): Promise<string> {
	const presentation = await readXml(archive, "ppt/presentation.xml", "PPTX");
	if (presentation.name !== "p:presentation") throw new Error("Invalid PPTX: presentation root is not p:presentation");
	const relations = relationships(await readXml(archive, "ppt/_rels/presentation.xml.rels", "PPTX"));
	const references = descendantElements(presentation, "p:sldId").map(item => item.attributes.get("r:id")).filter((value): value is string => value !== undefined);
	const slidePaths = references
		.map(reference => relations.get(reference))
		.map(target => (target === undefined ? undefined : archivePath("ppt", target)))
		.filter((path): path is string => path !== undefined);
	if (slidePaths.length === 0) {
		for (const entry of archive.indexEntries()) {
			if (/^ppt\/slides\/slide\d+\.xml$/u.test(entry.path)) slidePaths.push(entry.path);
		}
		slidePaths.sort((left, right) => Number(/slide(\d+)/u.exec(left)?.[1]) - Number(/slide(\d+)/u.exec(right)?.[1]));
	}
	if (slidePaths.length === 0) throw new Error("Invalid PPTX: no slide files");
	const sections: string[] = [];
	for (const [index, path] of slidePaths.entries()) {
		const slide = await readXml(archive, path, "PPTX");
		const lines = [`<!-- Slide ${index + 1} -->`];
		let title = true;
		for (const shape of descendantElements(slide, "p:sp")) {
			const text = valuesFromRuns(shape, "a:t");
			if (!text) continue;
			lines.push(title ? `# ${text}` : text);
			title = false;
		}
		for (const table of descendantElements(slide, "a:tbl")) {
			const rows = childElements(table, "a:tr").map(row => childElements(row, "a:tc").map(cell => valuesFromRuns(cell, "a:t")));
			const rendered = markdownTable(rows);
			if (rendered) lines.push(rendered);
		}
		for (const _image of descendantElements(slide, "p:pic")) lines.push("<!-- image omitted -->");
		sections.push(lines.join("\n"));
	}
	return sections.join("\n\n").trim();
}

function sharedString(item: XmlElement | undefined): string {
	return item === undefined ? "" : valuesFromRuns(item, "t");
}

function columnFromReference(reference: string | undefined, fallback: number): number {
	const letters = /^([A-Z]+)/iu.exec(reference ?? "")?.[1]?.toUpperCase();
	if (!letters) return fallback;
	let value = 0;
	for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
	return Math.max(0, value - 1);
}

function cellValue(cell: XmlElement, shared: readonly string[]): string {
	const type = cell.attributes.get("t");
	if (type === "inlineStr") return valuesFromRuns(cell, "t");
	const value = firstChildElement(cell, "v");
	if (value === undefined) return "";
	const raw = readText(value);
	if (type === "s") return shared[Number(raw)] ?? "";
	if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
	return raw;
}

async function convertXlsx(archive: ArchiveReader): Promise<string> {
	const workbook = await readXml(archive, "xl/workbook.xml", "XLSX");
	if (workbook.name !== "workbook") throw new Error("Invalid XLSX: workbook root is not workbook");
	const relationMap = relationships(await readXml(archive, "xl/_rels/workbook.xml.rels", "XLSX"));
	const sharedNode = archive.getNode("xl/sharedStrings.xml");
	const shared = sharedNode === undefined ? [] : childElements(await readXml(archive, "xl/sharedStrings.xml", "XLSX"), "si").map(sharedString);
	const sheets = descendantElements(workbook, "sheet");
	if (sheets.length === 0) throw new Error("Invalid XLSX: no sheets");
	const sections: string[] = [];
	for (const sheet of sheets) {
		const name = sheet.attributes.get("name") ?? "Sheet";
		const relation = sheet.attributes.get("r:id");
		const target = relation === undefined ? undefined : relationMap.get(relation);
		const path = target === undefined ? undefined : archivePath("xl", target);
		if (path === undefined) continue;
		const worksheet = await readXml(archive, path, "XLSX");
		const rows: string[][] = [];
		for (const row of descendantElements(worksheet, "row")) {
			const values: string[] = [];
			let nextColumn = 0;
			for (const cell of childElements(row, "c")) {
				const column = columnFromReference(cell.attributes.get("r"), nextColumn);
				while (values.length < column) values.push("");
				values[column] = cellValue(cell, shared);
				nextColumn = column + 1;
			}
			rows.push(values);
		}
		if (rows.length === 0) continue;
		sections.push(`## ${name}`);
		const rendered = markdownTable(rows);
		if (rendered) sections.push(rendered);
	}
	return sections.join("\n\n").trim();
}

function metadataValue(metadata: XmlElement, name: string): string | undefined {
	const values = childElements(metadata, name).map(readText).filter(Boolean);
	return values.length > 0 ? values.join(", ") : undefined;
}

async function convertEpub(archive: ArchiveReader): Promise<string> {
	const container = await readXml(archive, "META-INF/container.xml", "EPUB");
	const rootfile = descendantElements(container, "rootfile")[0];
	const opfPath = rootfile?.attributes.get("full-path");
	if (!opfPath) throw new Error("Invalid EPUB: missing rootfile path");
	const packageDocument = await readXml(archive, opfPath, "EPUB");
	if (packageDocument.name !== "package") throw new Error("Invalid EPUB: rootfile is not OPF package");
	const metadata = firstChildElement(packageDocument, "metadata");
	const manifest = firstChildElement(packageDocument, "manifest");
	const spine = firstChildElement(packageDocument, "spine");
	if (manifest === undefined || spine === undefined) throw new Error("Invalid EPUB: missing manifest or spine");
	const title = metadata === undefined ? undefined : metadataValue(metadata, "dc:title");
	const metadataLines = metadata === undefined
		? []
		: [
			["Title", title],
			["Authors", metadataValue(metadata, "dc:creator")],
			["Language", metadataValue(metadata, "dc:language")],
			["Publisher", metadataValue(metadata, "dc:publisher")],
			["Date", metadataValue(metadata, "dc:date")],
			["Description", metadataValue(metadata, "dc:description")],
		]
			.filter((entry): entry is [string, string] => entry[1] !== undefined)
			.map(([label, value]) => `**${label}:** ${value}`);
	const manifestPaths = new Map<string, string>();
	const opfBase = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
	for (const item of childElements(manifest, "item")) {
		const id = item.attributes.get("id");
		const href = item.attributes.get("href");
		const path = href === undefined ? undefined : archivePath(opfBase, href);
		if (id && path) manifestPaths.set(id, path);
	}
	const turndown = createTurndown();
	const chapters: string[] = [];
	for (const item of childElements(spine, "itemref")) {
		const path = manifestPaths.get(item.attributes.get("idref") ?? "");
		if (path === undefined) continue;
		const node = archive.getNode(path);
		if (node === undefined || node.isDirectory) continue;
		let html: string;
		try {
			html = XML_DECODER.decode((await archive.readFile(path)).bytes);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid EPUB: cannot read ${path}: ${message}`);
		}
		const noActiveContent = html
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
			.replace(/<img\b[^>]*>/giu, "<p>[image omitted]</p>");
		// Turndown 会把方括号作为普通文本转义；这里的占位是本工具公开的
		// Markdown 标记，恢复其字面形式，且不包含任何容器内图片路径。
		const markdown = turndown.turndown(noActiveContent).trim().replaceAll("\\[image omitted\\]", "[image omitted]");
		if (markdown) chapters.push(markdown);
	}
	return [...metadataLines, ...chapters].join("\n\n").trim();
}
