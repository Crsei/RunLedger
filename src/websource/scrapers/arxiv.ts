import { parseHTML } from "../internal/dom/index.ts";
import type { RenderResult, ScraperContext, SpecialHandler } from "./types.ts";
import { buildResult, loadPage } from "./types.ts";

/**
 * Handle arXiv URLs via arXiv API
 */
export const handleArxiv: SpecialHandler = async (
	url: string,
	timeout: number,
	context: ScraperContext,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "arxiv.org") return null;

		// Extract paper ID from various URL formats
		// /abs/1234.56789, /pdf/1234.56789, /abs/cs/0123456
		const match = parsed.pathname.match(/\/(abs|pdf)\/(.+?)(?:\.pdf)?$/);
		if (!match) return null;

		const paperId = match[2];
		const fetchedAt = new Date().toISOString();
		const notes: string[] = [];

		// Fetch metadata via arXiv API
		const apiUrl = `https://export.arxiv.org/api/query?id_list=${paperId}`;
		const result = await loadPage(context, apiUrl, { timeout, signal });

		if (!result.ok) return null;

		// Parse the Atom feed response
		const doc = parseHTML(result.content).document;
		const entry = doc.querySelector("entry");

		if (!entry) return null;

		const title = entry.querySelector("title")?.textContent?.trim()?.replace(/\s+/g, " ");
		const summary = entry.querySelector("summary")?.textContent?.trim();
		const authors = Array.from(entry.querySelectorAll("author name") as Iterable<{ textContent: string | null }>)
			.map(n => n.textContent?.trim())
			.filter((name): name is string => Boolean(name));
		const published = entry.querySelector("published")?.textContent?.trim()?.split("T")[0];
		const categories = Array.from(
			entry.querySelectorAll("category") as Iterable<{ getAttribute: (name: string) => string | null }>,
		)
			.map(c => c.getAttribute("term"))
			.filter((term): term is string => Boolean(term));

		let md = `# ${title || "arXiv Paper"}\n\n`;
		if (authors.length) md += `**Authors:** ${authors.join(", ")}\n`;
		if (published) md += `**Published:** ${published}\n`;
		if (categories.length) md += `**Categories:** ${categories.join(", ")}\n`;
		md += `**arXiv:** ${paperId}\n\n`;
		md += `---\n\n## Abstract\n\n${summary || "No abstract available."}\n\n`;

		// markit（PDF/DOCX→Markdown）不在本次移植范围，/pdf/ URL 只返回 API 摘要。
		return buildResult(md, {
			url,
			method: "arxiv",
			fetchedAt,
			notes: notes.length ? notes : ["Fetched via arXiv API"],
		});
	} catch {}

	return null;
};
