/** Buffer-only DOCX converter; archive and filesystem ownership remain with the caller. */

import type { ArchiveReader } from "../ar/index.ts";
import { documentXmlToMarkdown } from "./xml.ts";

const DECODER = new TextDecoder("utf-8", { fatal: true });

export async function convertDocxArchive(archive: ArchiveReader): Promise<string> {
	const document = archive.getNode("word/document.xml");
	if (document === undefined || document.isDirectory) throw new Error("Invalid DOCX: missing word/document.xml");
	const bytes = await archive.readFile("word/document.xml");
	try {
		return documentXmlToMarkdown(DECODER.decode(bytes.bytes));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid DOCX: ${message}`);
	}
}
