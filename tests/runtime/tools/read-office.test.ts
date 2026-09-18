/** Office/EPUB `read` 分支：只验证 Buffer 转换和受治理 read 分派，不依赖外部 office 工具。 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOfficeBytes } from "../../../src/runtime/tools/read-office.ts";
import { createReadTool, type ReadToolDetails } from "../../../src/runtime/tools/read.ts";
import { encodeZip } from "../../../src/websource/internal/ar/zip.ts";

const encode = new TextEncoder();
const bytes = (value: string): Uint8Array => encode.encode(value);

let directory: string;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "runledger-read-office-"));
});

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

async function zip(entries: readonly (readonly [string, string])[]): Promise<Uint8Array> {
	return encodeZip(entries.map(([path, value]) => [path, bytes(value)] as const));
}

async function officeRead(path: string): Promise<{ text: string; details: ReadToolDetails }> {
	const result = await createReadTool(directory).execute("office", { path });
	const [content] = result.content;
	return { text: content?.type === "text" ? content.text : "", details: result.details };
}

describe("Office and EPUB conversion", () => {
	it("converts DOCX body, tables, headings and image placeholders without extracting files", async () => {
		const input = await zip([
			["[Content_Types].xml", "<Types/>"],
			["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>
				<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>
				<w:p><w:r><w:t>Document body</w:t></w:r><w:drawing/></w:p>
				<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Key</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
			</w:body></w:document>`],
		]);
		const result = await readOfficeBytes(input, "docx");
		expect(result.text).toContain("# Overview");
		expect(result.text).toContain("Document body");
		expect(result.text).toContain("<!-- image omitted: 1 -->");
		expect(result.text).toContain("| Key | Value |");
	});

	it("converts PPTX slides in presentation order and retains table/image placeholders", async () => {
		const input = await zip([
			["[Content_Types].xml", "<Types/>"],
			["ppt/presentation.xml", `<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>`],
			["ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId2" Target="slides/slide7.xml"/></Relationships>`],
			["ppt/slides/slide7.xml", `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree>
				<p:sp><p:txBody><a:p><a:r><a:t>Deck title</a:t></a:r></a:p></p:txBody></p:sp>
				<p:sp><p:txBody><a:p><a:r><a:t>Point one</a:t></a:r></a:p></p:txBody></p:sp>
				<p:pic/><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
			</p:spTree></p:cSld></p:sld>`],
		]);
		const result = await readOfficeBytes(input, "pptx");
		expect(result.text).toContain("<!-- Slide 1 -->");
		expect(result.text).toContain("# Deck title");
		expect(result.text).toContain("Point one");
		expect(result.text).toContain("<!-- image omitted -->");
		expect(result.text).toContain("| A |");
	});

	it("converts XLSX shared and inline strings while retaining empty cells", async () => {
		const input = await zip([
			["[Content_Types].xml", "<Types/>"],
			["xl/sharedStrings.xml", `<sst><si><t>Name</t></si><si><r><t>Alice</t></r><r><t> Smith</t></r></si></sst>`],
			["xl/workbook.xml", `<workbook xmlns:r="urn:r"><sheets><sheet name="People" r:id="rId1"/></sheets></workbook>`],
			["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
			["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Age</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>`],
		]);
		const result = await readOfficeBytes(input, "xlsx");
		expect(result.text).toContain("## People");
		expect(result.text).toContain("| Name |  | Age |");
		expect(result.text).toContain("| Alice Smith |  | 42 |");
	});

	it("converts EPUB metadata and spine HTML, dropping active content and replacing images", async () => {
		const input = await zip([
			["mimetype", "application/epub+zip"],
			["META-INF/container.xml", `<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`],
			["OPS/book.opf", `<package><metadata><dc:title xmlns:dc="urn:dc">A Book</dc:title><dc:creator xmlns:dc="urn:dc">Author</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml"/></manifest><spine><itemref idref="chapter"/></spine></package>`],
			["OPS/chapter.xhtml", `<html><body><h1>Chapter One</h1><p>Readable <strong>text</strong>.</p><img src="cover.png"/><script>bad()</script></body></html>`],
		]);
		const result = await readOfficeBytes(input, "epub");
		expect(result.text).toContain("**Title:** A Book");
		expect(result.text).toContain("**Authors:** Author");
		expect(result.text).toContain("# Chapter One");
		expect(result.text).toContain("[image omitted]");
		expect(result.text).not.toContain("bad()");
	});

	it("rejects bad ZIP-backed documents and DTD entities instead of treating them as document text", async () => {
		await expect(readOfficeBytes(bytes("not a zip"), "docx")).rejects.toThrow();
		const withEntity = await zip([
			["word/document.xml", `<!DOCTYPE w:document [<!ENTITY boom "expanded">]><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>&boom;</w:t></w:r></w:p></w:body></w:document>`],
		]);
		await expect(readOfficeBytes(withEntity, "docx")).rejects.toThrow("DTD and custom entities");
	});

	it("uses governed read dispatch, converted Markdown selectors and the office media marker", async () => {
		const document = await zip([
			["word/document.xml", `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>line one</w:t></w:r></w:p><w:p><w:r><w:t>line two</w:t></w:r></w:p></w:body></w:document>`],
		]);
		writeFileSync(join(directory, "sample.docx"), document);
		const result = await officeRead("sample.docx:raw:3-3");
		expect(result.details.media).toBe("office");
		expect(result.text).toBe("line two");
	});

	it("falls back to the normal text path when an office extension has no ZIP magic", async () => {
		writeFileSync(join(directory, "notes.docx"), "still ordinary text\n");
		const result = await officeRead("notes.docx");
		expect(result.details.media).toBeUndefined();
		expect(result.text).toContain("still ordinary text");
	});
});
