/** 来源 oh-my-pi 3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec packages/agent/src/compaction/prompts/；保留 RunLedger 六段契约，MIT 许可见 budget.ts。 */
import { conservativeTokenEstimate } from "../token-estimator.ts";
import { escapeSummaryBoundaryTags } from "./summary-context.ts";

export type SummaryFormatId = "headings@1" | "headings-update@1" | "handoff-document@1";
export const SUMMARY_HEADINGS: readonly string[] = Object.freeze([
	"Goal and constraints", "Decisions and completed work", "Files and tool outcomes",
	"Unresolved tasks", "Verification evidence", "Source references",
]);
function validateHeadings(text: string): boolean {
	let previous = -1;
	for (const heading of SUMMARY_HEADINGS) {
		const index = text.indexOf(heading);
		if (index <= previous || text.indexOf(heading, index + heading.length) !== -1) return false;
		previous = index;
	}
	return true;
}
export const HANDOFF_HEADINGS: readonly string[] = Object.freeze([
	"## Goal", "## Constraints & Preferences", "## Progress", "### Done", "### In Progress", "### Pending",
	"## Key Decisions", "## Critical Context", "## Next Steps",
]);
function validateHandoff(text: string): boolean {
	const headings = text.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => /^#{2,3} /u.test(line));
	return headings.length === HANDOFF_HEADINGS.length && headings.every((heading, index) => heading === HANDOFF_HEADINGS[index]);
}
export const formatRegistry: Readonly<Record<SummaryFormatId, (text: string) => boolean>> = Object.freeze({
	"headings@1": validateHeadings,
	"headings-update@1": validateHeadings,
	"handoff-document@1": validateHandoff,
});
export function validSummaryFormat(format: SummaryFormatId, text: string): boolean {
	return typeof text === "string" && Buffer.byteLength(text) <= 131_072 && Object.hasOwn(formatRegistry, format) && formatRegistry[format](text);
}
export interface SummaryPromptInput {
	readonly content: string;
	readonly previousSummary?: string;
	readonly focus?: string;
	readonly format: SummaryFormatId;
}
export function summaryPromptText(input: SummaryPromptInput): string {
	return [
		...(input.focus === undefined ? [] : [`<focus>\n${escapeSummaryBoundaryTags(input.focus)}\n</focus>`]),
		...(input.previousSummary === undefined ? [] : [`<previous-summary>\n${escapeSummaryBoundaryTags(input.previousSummary)}\n</previous-summary>`]),
		`<conversation>\n${escapeSummaryBoundaryTags(input.content)}\n</conversation>`,
	].join("\n\n");
}
/** 与生产 user prompt 使用同一序列化；累计预算也覆盖前次摘要、focus 和边界转义。 */
export function summaryInputTokens(input: SummaryPromptInput): number {
	return conservativeTokenEstimate(JSON.stringify({ content: summaryPromptText(input) }));
}
