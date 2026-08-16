/**
 * 流式 Markdown 表格的保守闭合检测。
 *
 * 只有表头、delimiter、至少一行数据以及后续空行都已到达，并且空行后
 * 紧接着出现非表格内容时才返回拆分点；未知情况保持 streaming。
 */

export interface StreamingTableSplit {
	readonly tableStart: number;
	/** 表格正文结束位置，不包含正文末尾换行。 */
	readonly tableEnd: number;
	/** settled 前缀结束位置，包含分隔空行。 */
	readonly prefixEnd: number;
	readonly prefixText: string;
	readonly tableText: string;
	readonly tailText: string;
	readonly rowCount: number;
}

interface SourceLine {
	readonly text: string;
	readonly start: number;
	readonly contentEnd: number;
	readonly end: number;
}

export function splitClosedStreamingTable(text: string): StreamingTableSplit | undefined {
	const lines = sourceLines(text);
	for (let headerIndex = 0; headerIndex + 2 < lines.length; headerIndex += 1) {
		const header = lines[headerIndex];
		const delimiter = lines[headerIndex + 1];
		if (header === undefined || delimiter === undefined) continue;
		if (!isMarkdownTableRow(header.text) || isMarkdownTableDelimiter(header.text)) continue;
		if (!isMarkdownTableDelimiter(delimiter.text)) continue;

		let lastTableIndex = headerIndex + 1;
		let dataRows = 0;
		for (let rowIndex = headerIndex + 2; rowIndex < lines.length; rowIndex += 1) {
			const row = lines[rowIndex];
			if (row === undefined || !isMarkdownTableRow(row.text)) break;
			lastTableIndex = rowIndex;
			dataRows += 1;
		}
		if (dataRows === 0) continue;

		const blank = lines[lastTableIndex + 1];
		const tail = lines[lastTableIndex + 2];
		if (blank === undefined || blank.text.trim().length !== 0 || tail === undefined) continue;
		if (isMarkdownTableRow(tail.text)) continue;

		const lastTableLine = lines[lastTableIndex];
		return {
			tableStart: header.start,
			tableEnd: lastTableLine?.contentEnd ?? delimiter.contentEnd,
			prefixEnd: blank.end,
			prefixText: text.slice(0, blank.end),
			tableText: text.slice(header.start, lastTableLine?.contentEnd ?? delimiter.contentEnd),
			tailText: text.slice(blank.end),
			rowCount: dataRows + 2,
		};
	}
	return undefined;
}

export function isMarkdownTableDelimiter(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length < 5 || !trimmed.includes("-")) return false;
	const cells = trimmed.replace(/^\|/u, "").replace(/\|$/u, "").split("|");
	return cells.length >= 1 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function isMarkdownTableRow(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0 || !trimmed.includes("|")) return false;
	let separators = 0;
	let escaped = false;
	for (const character of trimmed) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "|") separators += 1;
	}
	return separators >= 1;
}

function sourceLines(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const contentEnd = newline < 0 ? text.length : newline;
		const raw = text.slice(start, contentEnd);
		const lineText = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		lines.push({
			text: lineText,
			start,
			contentEnd,
			end: newline < 0 ? text.length : newline + 1,
		});
		if (newline < 0) break;
		start = newline + 1;
	}
	return lines;
}
